import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntime } from "./runtime.js";
import { fakeClient, makeConfig, quietLogger } from "./testing/helpers.js";

test("builds JSON stores when MongoDB is not configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-runtime-"));
  try {
    const runtime = await createRuntime({
      client: fakeClient(),
      config: makeConfig({ mongoUri: null }),
      logger: quietLogger,
      dataDir: dir,
    });
    assert.equal(runtime.cases.durable, false);
    assert.equal(runtime.auditStore.durable, false);
    assert.equal(runtime.auditChannels.size, 0);
    await runtime.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup and shutdown are recorded in the archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-runtime-"));
  try {
    const runtime = await createRuntime({
      client: fakeClient(),
      config: makeConfig({ mongoUri: null }),
      logger: quietLogger,
      dataDir: dir,
    });
    await runtime.shutdown();
    const events = await runtime.auditStore.query({
      guildId: makeConfig().guildId,
      limit: 20,
    });
    const types = events.map((event) => event.type);
    assert.ok(types.includes("bot.startup"));
    assert.ok(types.includes("bot.shutdown"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-runtime-"));
  try {
    const runtime = await createRuntime({
      client: fakeClient(),
      config: makeConfig({ mongoUri: null }),
      logger: quietLogger,
      dataDir: dir,
    });
    await runtime.shutdown();
    await runtime.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
