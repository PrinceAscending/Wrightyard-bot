import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GUILD_ID, USER_ID, quietLogger } from "../testing/helpers.js";
import { SecurityStateStore } from "./state.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-security-state-"));
}

test("persists raid mode through the JSON fallback", async () => {
  const dir = await tempDir();
  try {
    const store = new SecurityStateStore({
      database: null,
      jsonPath: join(dir, "security-state.json"),
      logger: quietLogger,
    });
    await store.setRaidMode(GUILD_ID, new Date("2026-11-09T00:10:00Z"));
    const active = await store.get(GUILD_ID);
    assert.equal(active.raidMode, true);
    assert.equal(active.raidUntil?.toISOString(), "2026-11-09T00:10:00.000Z");

    await store.setRaidMode(GUILD_ID, null);
    const inactive = await store.get(GUILD_ID);
    assert.equal(inactive.raidMode, false);
    assert.equal(inactive.raidUntil, null);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing state returns empty defaults", async () => {
  const dir = await tempDir();
  try {
    const store = new SecurityStateStore({
      database: null,
      jsonPath: join(dir, "security-state.json"),
      logger: quietLogger,
    });
    const state = await store.get(GUILD_ID);
    assert.equal(state.raidMode, false);
    assert.equal(state.raidUntil, null);
    assert.deepEqual(state.lastActionAt, {});
    assert.equal(state.lastAlertAt, null);
    assert.equal(state.updatedAt, null);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists actor action marks and the last alert across reloads", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "security-state.json");
    const first = new SecurityStateStore({
      database: null,
      jsonPath: path,
      logger: quietLogger,
    });
    await first.setRaidMode(GUILD_ID, null);
    await first.markAction(GUILD_ID, USER_ID, new Date("2026-11-09T01:00:00Z"));
    await first.markAction(GUILD_ID, USER_ID, new Date("2026-11-09T02:00:00Z"));
    await first.markAlert(GUILD_ID, new Date("2026-11-09T03:00:00Z"));
    await first.close();

    const second = new SecurityStateStore({
      database: null,
      jsonPath: path,
      logger: quietLogger,
    });
    const state = await second.get(GUILD_ID);
    assert.equal(state.lastActionAt[USER_ID], "2026-11-09T02:00:00.000Z");
    assert.equal(state.lastAlertAt?.toISOString(), "2026-11-09T03:00:00.000Z");
    assert.ok(state.updatedAt instanceof Date);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
