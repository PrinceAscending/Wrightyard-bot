import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AuditLogEvent,
  Collection,
  type GuildAuditLogsEntry,
  type Client,
  type Guild,
} from "discord.js";
import {
  ACTOR_ID,
  GUILD_ID,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import type { AuditService } from "./service.js";
import type { AuditEventInput } from "./types.js";
import { AuditCursorStore } from "./cursors.js";
import { AuditReconciler } from "./reconcile.js";

interface EntryOptions {
  id: string;
  action: AuditLogEvent;
}

function makeEntry(options: EntryOptions) {
  return {
    id: options.id,
    action: options.action,
    targetId: "1567000000000000004",
    executorId: ACTOR_ID,
    executor: { id: ACTOR_ID, tag: "actor#0001" },
    reason: null,
    createdTimestamp: Date.now(),
  };
}

function makeGuild(entries: Collection<string, ReturnType<typeof makeEntry>>): Guild {
  return {
    id: GUILD_ID,
    fetchAuditLogs: async ({
      type,
      after,
    }: {
      type?: AuditLogEvent;
      after?: string;
    } = {}) => ({
      entries: new Collection(
        [...entries.values()]
          .filter((entry) => !type || entry.action === type)
          .filter((entry) => !after || BigInt(entry.id) > BigInt(after))
          .map((entry) => [entry.id, entry]),
      ),
    }),
  } as unknown as Guild;
}

function recording(events: AuditEventInput[]): AuditService {
  return {
    record: (event: AuditEventInput) => {
      events.push(event);
    },
  } as unknown as AuditService;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-reconcile-"));
}

test("first poll stores the cursor without backfilling", async () => {
  const dir = await tempDir();
  try {
    const recorded: AuditEventInput[] = [];
    const entries = new Collection<string, ReturnType<typeof makeEntry>>();
    const cursors = new AuditCursorStore({
      database: null,
      jsonPath: join(dir, "cursors-first.json"),
      logger: quietLogger,
    });
    const reconciler = new AuditReconciler({
      client: fakeClient([makeGuild(entries)]) as unknown as Client,
      config: makeConfig(),
      audit: recording(recorded),
      logger: quietLogger,
      cursors,
      intervalMs: 60_000,
      staggerMs: 0,
    });
    entries.set("100", makeEntry({ id: "100", action: AuditLogEvent.ChannelDelete }));
    await reconciler.pollOnce();
    assert.equal(recorded.length, 0);
    assert.equal(await cursors.get(String(AuditLogEvent.ChannelDelete)), "100");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("second poll records new entries once", async () => {
  const dir = await tempDir();
  try {
    const recorded: AuditEventInput[] = [];
    const entries = new Collection<string, ReturnType<typeof makeEntry>>();
    const cursors = new AuditCursorStore({
      database: null,
      jsonPath: join(dir, "cursors-second.json"),
      logger: quietLogger,
    });
    const reconciler = new AuditReconciler({
      client: fakeClient([makeGuild(entries)]) as unknown as Client,
      config: makeConfig(),
      audit: recording(recorded),
      logger: quietLogger,
      cursors,
      intervalMs: 60_000,
      staggerMs: 0,
    });
    entries.set("100", makeEntry({ id: "100", action: AuditLogEvent.ChannelDelete }));
    await reconciler.pollOnce();
    entries.set("101", makeEntry({ id: "101", action: AuditLogEvent.ChannelDelete }));
    await reconciler.pollOnce();
    await reconciler.pollOnce();
    assert.equal(recorded.filter((event) => event.type === "channel.delete").length, 1);
    assert.equal(await cursors.get(String(AuditLogEvent.ChannelDelete)), "101");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new entries are archive-only and carry the actor", async () => {
  const dir = await tempDir();
  try {
    const recorded: AuditEventInput[] = [];
    const entries = new Collection<string, ReturnType<typeof makeEntry>>();
    const cursors = new AuditCursorStore({
      database: null,
      jsonPath: join(dir, "cursors-third.json"),
      logger: quietLogger,
    });
    const reconciler = new AuditReconciler({
      client: fakeClient([makeGuild(entries)]) as unknown as Client,
      config: makeConfig(),
      audit: recording(recorded),
      logger: quietLogger,
      cursors,
      intervalMs: 60_000,
      staggerMs: 0,
    });
    entries.set("100", makeEntry({ id: "100", action: AuditLogEvent.ChannelDelete }));
    await reconciler.pollOnce();
    entries.set("101", makeEntry({ id: "101", action: AuditLogEvent.ChannelDelete }));
    await reconciler.pollOnce();
    const event = recorded[0];
    assert.equal(event?.feed, false);
    assert.equal(event?.actor?.id, ACTOR_ID);
    assert.equal(event?.category, "server");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entries with unknown action types are ignored", () => {
  const entry = makeEntry({ id: "1", action: AuditLogEvent.ChannelDelete }) as unknown as GuildAuditLogsEntry;
  assert.equal(entry.id, "1");
});
