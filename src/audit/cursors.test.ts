import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietLogger } from "../testing/helpers.js";
import { AuditCursorStore } from "./cursors.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrightyard-cursors-"));
}

test("set and get round-trip through the JSON fallback", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "cursors.json");
    const store = new AuditCursorStore({ database: null, jsonPath: path, logger: quietLogger });
    assert.equal(await store.get("1"), null);
    await store.set("1", "100");
    await store.close();

    const reopened = new AuditCursorStore({ database: null, jsonPath: path, logger: quietLogger });
    assert.equal(await reopened.get("1"), "100");
    assert.equal(await reopened.get("2"), null);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a later set replaces the cursor", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "cursors.json");
    const store = new AuditCursorStore({ database: null, jsonPath: path, logger: quietLogger });
    await store.set("1", "100");
    await store.set("1", "101");
    await store.set("2", "5");
    await store.close();

    const reopened = new AuditCursorStore({ database: null, jsonPath: path, logger: quietLogger });
    assert.equal(await reopened.get("1"), "101");
    assert.equal(await reopened.get("2"), "5");
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
