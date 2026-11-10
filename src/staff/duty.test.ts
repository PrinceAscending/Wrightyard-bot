import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GUILD_ID, STAFF_ID, quietLogger } from "../testing/helpers.js";
import { DutyStore } from "./duty.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-duty-"));
}

test("duty start and stop produce a session", async () => {
  const dir = await tempDir();
  try {
    const store = new DutyStore({
      database: null,
      jsonPath: join(dir, "duty.json"),
      logger: quietLogger,
    });
    const started = await store.start(
      GUILD_ID,
      STAFF_ID,
      new Date("2026-11-09T00:00:00Z"),
    );
    await store.stop(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:30:00Z"));
    assert.equal(started.endedAt, null);
    assert.equal(await store.activeSession(GUILD_ID, STAFF_ID), null);
    assert.equal(
      await store.minutesSince(GUILD_ID, STAFF_ID, new Date("2026-11-08T00:00:00Z")),
      30,
    );
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start is idempotent while a session is open", async () => {
  const dir = await tempDir();
  try {
    const store = new DutyStore({
      database: null,
      jsonPath: join(dir, "duty.json"),
      logger: quietLogger,
    });
    const first = await store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:00Z"));
    const second = await store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T01:00:00Z"));
    assert.equal(second.id, first.id);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent starts still create one session", async () => {
  const dir = await tempDir();
  try {
    const store = new DutyStore({
      database: null,
      jsonPath: join(dir, "duty.json"),
      logger: quietLogger,
    });
    const [first, second] = await Promise.all([
      store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:00Z")),
      store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:01Z")),
    ]);
    assert.equal(first.id, second.id);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("closeStaleSessions closes every open session", async () => {
  const dir = await tempDir();
  try {
    const store = new DutyStore({
      database: null,
      jsonPath: join(dir, "duty.json"),
      logger: quietLogger,
    });
    await store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:00Z"));
    await store.start(GUILD_ID, "another", new Date("2026-11-09T00:10:00Z"));
    const closed = await store.closeStaleSessions(
      GUILD_ID,
      new Date("2026-11-09T02:00:00Z"),
    );
    assert.equal(closed, 2);
    assert.equal(await store.activeSession(GUILD_ID, STAFF_ID), null);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("minutesSince clips to the requested window", async () => {
  const dir = await tempDir();
  try {
    const store = new DutyStore({
      database: null,
      jsonPath: join(dir, "duty.json"),
      logger: quietLogger,
    });
    await store.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:00Z"));
    await store.stop(GUILD_ID, STAFF_ID, new Date("2026-11-09T01:00:00Z"));
    assert.equal(
      await store.minutesSince(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:30:00Z")),
      30,
    );
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duty persists across a reopen", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "duty.json");
    const first = new DutyStore({ database: null, jsonPath: path, logger: quietLogger });
    await first.start(GUILD_ID, STAFF_ID, new Date("2026-11-09T00:00:00Z"));
    await first.close();

    const second = new DutyStore({ database: null, jsonPath: path, logger: quietLogger });
    const active = await second.activeSession(GUILD_ID, STAFF_ID);
    assert.ok(active);
    assert.equal(active?.moderatorId, STAFF_ID);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
