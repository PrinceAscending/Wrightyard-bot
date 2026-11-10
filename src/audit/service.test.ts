import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, quietLogger } from "../testing/helpers.js";
import { AuditService } from "./service.js";
import type { AuditStore } from "./store.js";
import type { AuditEvent } from "./types.js";

interface Harness {
  stored: AuditEvent[];
  fed: AuditEvent[];
  service: AuditService;
}

function harness(
  append: (event: AuditEvent) => Promise<void> = async (event) => {
    void event;
  },
): Harness {
  const stored: AuditEvent[] = [];
  const fed: AuditEvent[] = [];
  const service = new AuditService({
    guildId: GUILD_ID,
    store: {
      append: async (event: AuditEvent) => {
        await append(event);
        stored.push(event);
      },
      close: async () => undefined,
    } as unknown as AuditStore,
    sink: {
      enqueue: (event) => {
        fed.push(event);
      },
      flush: async () => undefined,
      close: async () => undefined,
    },
    logger: quietLogger,
    idFactory: () => `evt-${stored.length + fed.length}`,
    now: () => new Date("2026-11-09T00:00:00Z"),
  });
  return { stored, fed, service };
}

test("records to the store and sink", async () => {
  const { stored, fed, service } = harness();
  const event = await service.recordNow({
    category: "message",
    type: "message.delete",
    summary: "deleted",
  });
  assert.equal(event.id, "evt-0");
  assert.equal(stored.length, 1);
  assert.equal(fed.length, 1);
});

test("archive-only events skip the sink", async () => {
  const { stored, fed, service } = harness();
  service.record({
    category: "message",
    type: "message.create",
    summary: "created",
    feed: false,
  });
  await service.flush();
  assert.equal(stored.length, 1);
  assert.equal(fed.length, 0);
});

test("failed appends are retried once on flush and still feed alerts", async () => {
  let attempts = 0;
  const { stored, fed, service } = harness(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("disk full");
    }
  });
  service.record({ category: "security", type: "security.alert", summary: "nuke" });
  await service.flush();
  assert.equal(attempts, 2);
  assert.equal(stored.length, 1);
  assert.equal(fed.length, 1);
});

test("close reports events that still cannot be persisted", async () => {
  const { service } = harness(async () => {
    throw new Error("disk full");
  });
  service.record({ category: "message", type: "message.create", summary: "x" });
  await service.close();
});
