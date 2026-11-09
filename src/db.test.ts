import assert from "node:assert/strict";
import { test } from "node:test";
import { BotDatabase } from "./db.js";
import { quietLogger } from "./testing/helpers.js";

test("unconfigured database rejects collection access", async () => {
  const db = new BotDatabase({ uri: null, dbName: "wrightyard", logger: quietLogger });
  assert.equal(db.configured, false);
  await assert.rejects(() => db.collection("audit_events"), /MongoDB is not configured/);
});

test("closing an unconfigured database is a no-op", async () => {
  const db = new BotDatabase({ uri: null, dbName: "wrightyard", logger: quietLogger });
  await db.close();
  assert.equal(db.configured, false);
});
