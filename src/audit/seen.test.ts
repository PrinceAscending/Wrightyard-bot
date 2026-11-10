import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietLogger } from "../testing/helpers.js";
import { AuditSeenStore } from "./seen.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-audit-seen-"));
}

test("dedupes entry ids and prunes the oldest ids", async () => {
  const dir = await tempDir();
  try {
    const store = new AuditSeenStore({
      database: null,
      jsonPath: join(dir, "audit-seen.json"),
      logger: quietLogger,
      maxEntries: 2,
    });
    await store.add("100");
    await store.add("101");
    await store.add("102");
    assert.equal(await store.has("100"), false);
    assert.equal(await store.has("101"), true);
    assert.equal(await store.has("102"), true);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("add is idempotent and survives a reload", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "audit-seen.json");
    const first = new AuditSeenStore({
      database: null,
      jsonPath: path,
      logger: quietLogger,
    });
    await first.add("200");
    await first.add("200");
    await first.add("201");
    await first.close();

    const second = new AuditSeenStore({
      database: null,
      jsonPath: path,
      logger: quietLogger,
    });
    assert.equal(await second.has("200"), true);
    assert.equal(await second.has("201"), true);
    assert.equal(await second.has("202"), false);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune enforces the cap without removing the newest ids", async () => {
  const dir = await tempDir();
  try {
    const store = new AuditSeenStore({
      database: null,
      jsonPath: join(dir, "audit-seen.json"),
      logger: quietLogger,
      maxEntries: 3,
    });
    for (const id of ["300", "301", "302", "303", "304"]) {
      await store.add(id);
    }
    await store.prune();
    assert.equal(await store.has("304"), true);
    assert.equal(await store.has("303"), true);
    assert.equal(await store.has("302"), true);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
