import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BotDatabase } from "../db.js";
import { GUILD_ID, quietLogger } from "../testing/helpers.js";
import { AuditStore } from "./store.js";
import { createAuditEvent, type AuditCategory } from "./types.js";

function makeEvent(id: string, category: AuditCategory, iso: string) {
  return createAuditEvent(
    { category, type: `${category}.test`, summary: `event ${id}` },
    GUILD_ID,
    id,
    new Date(iso),
  );
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), "wrightyard-audit-"));
}

test("appends and queries NDJSON events newest first", async () => {
  const dir = await tempDir();
  try {
    const store = new AuditStore({
      database: null,
      jsonPath: join(dir, "audit.ndjson"),
      logger: quietLogger,
      retentionDays: 0,
    });
    assert.equal(store.durable, false);
    await store.append(makeEvent("a", "message", "2026-11-09T00:00:00Z"));
    await store.append(makeEvent("b", "member", "2026-11-09T00:00:01Z"));

    const all = await store.query({ guildId: GUILD_ID, limit: 10 });
    assert.deepEqual(all.map((event) => event.id), ["b", "a"]);
    assert.ok(all[0]?.createdAt instanceof Date);

    const messages = await store.query({ guildId: GUILD_ID, category: "message" });
    assert.deepEqual(messages.map((event) => event.id), ["a"]);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filters by since and limit and skips malformed lines", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "audit.ndjson");
    const store = new AuditStore({
      database: null,
      jsonPath: path,
      logger: quietLogger,
      retentionDays: 0,
    });
    await store.append(makeEvent("old", "message", "2026-11-08T00:00:00Z"));
    await store.append(makeEvent("new-1", "message", "2026-11-09T00:00:00Z"));
    await store.append(makeEvent("new-2", "message", "2026-11-09T00:00:05Z"));
    await writeFile(path, `${await readFile(path, "utf8")}{ not json }\n`, "utf8");

    const recent = await store.query({
      guildId: GUILD_ID,
      since: new Date("2026-11-09T00:00:00Z"),
      limit: 1,
    });
    assert.deepEqual(recent.map((event) => event.id), ["new-2"]);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to JSON when Mongo fails and stays non-durable", async () => {
  const dir = await tempDir();
  try {
    const database = {
      collection: async () => {
        throw new Error("mongo is down");
      },
    } as unknown as BotDatabase;
    const store = new AuditStore({
      database,
      jsonPath: join(dir, "audit.ndjson"),
      logger: quietLogger,
      retentionDays: 0,
    });
    assert.equal(store.durable, true);

    await store.append(makeEvent("fallback", "security", "2026-11-09T00:00:00Z"));
    assert.equal(store.durable, false);

    const events = await store.query({ guildId: GUILD_ID });
    assert.deepEqual(events.map((event) => event.id), ["fallback"]);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
