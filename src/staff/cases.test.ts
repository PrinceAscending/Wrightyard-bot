import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GUILD_ID,
  STAFF_ID,
  TARGET_ID,
  USER_ID,
  quietLogger,
} from "../testing/helpers.js";
import { CaseStore, type NewCase } from "./cases.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-cases-"));
}

function makeCase(overrides: Partial<NewCase> = {}): NewCase {
  return {
    guildId: GUILD_ID,
    action: "warn",
    targetId: TARGET_ID,
    targetTag: "target#0001",
    moderatorId: STAFF_ID,
    moderatorTag: "staff#0001",
    reason: "spam",
    ...overrides,
  };
}

test("assigns sequential case numbers and filters", async () => {
  const dir = await tempDir();
  try {
    const store = new CaseStore({
      database: null,
      jsonPath: join(dir, "cases.json"),
      logger: quietLogger,
    });
    const first = await store.create(
      makeCase({ action: "warn", targetId: USER_ID, moderatorId: STAFF_ID }),
    );
    const second = await store.create(
      makeCase({ action: "timeout", targetId: USER_ID, moderatorId: STAFF_ID }),
    );
    assert.equal(first.caseId, 1);
    assert.equal(second.caseId, 2);
    assert.equal((await store.get(GUILD_ID, 2))?.action, "timeout");
    assert.equal((await store.list(GUILD_ID, { targetId: USER_ID })).length, 2);
    assert.equal(await store.countByModerator(GUILD_ID, STAFF_ID, new Date(0)), 2);
    await store.updateStatus(GUILD_ID, 1, "revoked", STAFF_ID, "cleared");
    const updated = await store.get(GUILD_ID, 1);
    assert.equal(updated?.status, "revoked");
    assert.equal(updated?.metadata.statusActorId, STAFF_ID);
    assert.equal(updated?.metadata.statusNote, "cleared");
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default statuses follow the action", async () => {
  const dir = await tempDir();
  try {
    const store = new CaseStore({
      database: null,
      jsonPath: join(dir, "statuses.json"),
      logger: quietLogger,
    });
    const warn = await store.create(makeCase({ action: "warn" }));
    const timeout = await store.create(
      makeCase({ action: "timeout", durationMs: 600_000, expiresAt: new Date(Date.now() + 600_000) }),
    );
    const kick = await store.create(makeCase({ action: "kick" }));
    const note = await store.create(makeCase({ action: "note" }));
    const report = await store.create(makeCase({ action: "report" }));
    assert.equal(warn.status, "open");
    assert.equal(timeout.status, "open");
    assert.ok(timeout.expiresAt instanceof Date);
    assert.equal(kick.status, "closed");
    assert.equal(note.status, "closed");
    assert.equal(report.status, "open");
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists newest first and applies action, status, since, and limit filters", async () => {
  const dir = await tempDir();
  try {
    const store = new CaseStore({
      database: null,
      jsonPath: join(dir, "filters.json"),
      logger: quietLogger,
    });
    await store.create(makeCase({ action: "warn" }));
    await store.create(makeCase({ action: "ban", targetId: USER_ID }));
    await store.create(makeCase({ action: "note" }));
    await store.create(makeCase({ action: "ban", targetId: USER_ID }));

    const bans = await store.list(GUILD_ID, { action: "ban" });
    assert.deepEqual(bans.map((record) => record.caseId), [4, 2]);
    assert.equal((await store.list(GUILD_ID, { status: "open" })).length, 3);
    assert.equal((await store.list(GUILD_ID, { limit: 2 })).length, 2);
    assert.equal((await store.list(GUILD_ID, { since: new Date(Date.now() + 60_000) })).length, 0);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markExpired closes only past-due open cases", async () => {
  const dir = await tempDir();
  try {
    const store = new CaseStore({
      database: null,
      jsonPath: join(dir, "cases.json"),
      logger: quietLogger,
    });
    await store.create(
      makeCase({ action: "timeout", expiresAt: new Date("2026-11-09T00:00:00Z") }),
    );
    await store.create(
      makeCase({ action: "timeout", expiresAt: new Date("2026-11-10T00:00:00Z") }),
    );
    const count = await store.markExpired(
      GUILD_ID,
      new Date("2026-11-09T12:00:00Z"),
    );
    assert.equal(count, 1);
    assert.equal((await store.get(GUILD_ID, 1))?.status, "expired");
    assert.equal((await store.get(GUILD_ID, 2))?.status, "open");
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists cases across a reopen", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "persist.json");
    const first = new CaseStore({ database: null, jsonPath: path, logger: quietLogger });
    await first.create(makeCase());
    await first.close();

    const second = new CaseStore({ database: null, jsonPath: path, logger: quietLogger });
    const record = await second.get(GUILD_ID, 1);
    assert.equal(record?.action, "warn");
    assert.equal(record?.createdAt instanceof Date, true);
    assert.equal(second.durable, false);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("countByModerator respects the since boundary", async () => {
  const dir = await tempDir();
  try {
    const store = new CaseStore({
      database: null,
      jsonPath: join(dir, "counts.json"),
      logger: quietLogger,
    });
    await store.create(makeCase({ moderatorId: STAFF_ID }));
    await store.create(makeCase({ moderatorId: "other" }));
    assert.equal(await store.countByModerator(GUILD_ID, STAFF_ID, new Date(0)), 1);
    assert.equal(
      await store.countByModerator(GUILD_ID, STAFF_ID, new Date(Date.now() + 60_000)),
      0,
    );
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
