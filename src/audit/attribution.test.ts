import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLogEvent, Collection, type Guild } from "discord.js";
import {
  ACTOR_ID,
  GUILD_ID,
  TARGET_ID,
  quietLogger,
} from "../testing/helpers.js";
import {
  AuditLogResolver,
  attributionFailureEvent,
} from "./attribution.js";

interface EntryOptions {
  id?: string;
  targetId?: string;
  executorId?: string;
  ageMs?: number;
  executor?: { id: string; tag: string } | null;
}

function makeEntry(options: EntryOptions = {}) {
  const executorId = options.executorId ?? ACTOR_ID;
  return {
    id: options.id ?? `entry-${Math.random().toString(16).slice(2)}`,
    targetId: options.targetId ?? TARGET_ID,
    executorId,
    createdTimestamp: Date.now() - (options.ageMs ?? 500),
    executor:
      options.executor === undefined
        ? { id: executorId, tag: "actor#0001" }
        : options.executor,
  };
}

function page(entries: ReturnType<typeof makeEntry>[]) {
  return { entries: new Collection(entries.map((entry) => [entry.id, entry])) };
}

function makeGuild(pages: ReturnType<typeof page>[]): Guild {
  let calls = 0;
  return {
    fetchAuditLogs: async () => pages[Math.min(calls++, pages.length - 1)]!,
  } as unknown as Guild;
}

const noDelay = async () => undefined;

test("matches target, time, and ignores the bot", async () => {
  const entry = makeEntry({ targetId: TARGET_ID, executorId: ACTOR_ID, ageMs: 1_000 });
  const resolver = new AuditLogResolver({ logger: quietLogger, delay: noDelay });
  const actor = await resolver.resolve(
    makeGuild([page([entry])]),
    AuditLogEvent.ChannelDelete,
    TARGET_ID,
    new Date(Date.now() - 5_000),
  );
  assert.deepEqual(actor, { id: ACTOR_ID, tag: "actor#0001" });
});

test("retries when the audit entry is late", async () => {
  const entry = makeEntry({ targetId: TARGET_ID, executorId: ACTOR_ID, ageMs: 500 });
  const pages = [page([]), page([entry])];
  let calls = 0;
  const guild = {
    fetchAuditLogs: async () => {
      const result = pages[calls] ?? page([]);
      calls += 1;
      return result;
    },
  };
  const resolver = new AuditLogResolver({ logger: quietLogger, delay: noDelay });
  const actor = await resolver.resolve(
    guild as unknown as Guild,
    AuditLogEvent.ChannelDelete,
    TARGET_ID,
    new Date(Date.now() - 5_000),
  );
  assert.equal(actor?.id, ACTOR_ID);
  assert.equal(calls, 2);
});

test("ignores stale entries and the bot itself", async () => {
  const stale = makeEntry({ targetId: TARGET_ID, ageMs: 60_000 });
  const resolver = new AuditLogResolver({
    client: { user: { id: ACTOR_ID } },
    logger: quietLogger,
    delay: noDelay,
    maxAttempts: 1,
  });
  const actor = await resolver.resolve(
    makeGuild([page([stale])]),
    AuditLogEvent.ChannelDelete,
    TARGET_ID,
    new Date(Date.now() - 5_000),
  );
  assert.equal(actor, null);
});

test("resolveMany maps targets", async () => {
  const entries = [
    makeEntry({ targetId: "111111111111111111", executorId: ACTOR_ID, ageMs: 500 }),
    makeEntry({ targetId: "222222222222222222", executorId: ACTOR_ID, ageMs: 500 }),
  ];
  const resolver = new AuditLogResolver({ logger: quietLogger, delay: noDelay });
  const actors = await resolver.resolveMany(
    makeGuild([page(entries)]),
    AuditLogEvent.MemberRoleUpdate,
    ["111111111111111111", "222222222222222222"],
    new Date(Date.now() - 5_000),
  );
  assert.equal(actors.size, 2);
});

test("attribution failure records an unknown critical alert", () => {
  const event = attributionFailureEvent({
    guildId: GUILD_ID,
    type: "channelDelete",
    targetId: TARGET_ID,
    targetName: "general",
  });
  assert.equal(event.type, "security.alert");
  assert.equal(event.severity, "critical");
  assert.equal(event.actor?.id, "unknown");
});
