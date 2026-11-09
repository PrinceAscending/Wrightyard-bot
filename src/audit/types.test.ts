import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_ID, CHANNEL_ID, GUILD_ID, TARGET_ID } from "../testing/helpers.js";
import { createAuditEvent } from "./types.js";

test("creates an info event with a stable shape", () => {
  const event = createAuditEvent(
    { category: "member", type: "member.join", summary: "A joined" },
    GUILD_ID,
    "evt-1",
    new Date("2026-11-09T00:00:00Z"),
  );
  assert.equal(event.id, "evt-1");
  assert.equal(event.severity, "info");
  assert.equal(event.feed, true);
  assert.equal(event.guildId, GUILD_ID);
  assert.equal(event.createdAt.toISOString(), "2026-11-09T00:00:00.000Z");
});

test("generates an id and timestamp when they are omitted", () => {
  const before = Date.now();
  const event = createAuditEvent(
    { category: "command", type: "command.served", summary: "served" },
    GUILD_ID,
  );

  assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(event.createdAt.getTime() >= before);
});

test("carries optional input through unchanged", () => {
  const actor = { id: ACTOR_ID, tag: "actor#0001" };
  const target = { id: TARGET_ID, name: "target" };
  const fields = [{ name: "Reason", value: "spam" }];
  const payload = { caseId: 1 };

  const event = createAuditEvent(
    {
      category: "moderation",
      type: "moderation.action",
      summary: "warned a member",
      severity: "warn",
      actor,
      target,
      channelId: CHANNEL_ID,
      fields,
      payload,
      feed: false,
    },
    GUILD_ID,
    "evt-2",
    new Date("2026-11-09T00:00:01Z"),
  );

  assert.equal(event.severity, "warn");
  assert.equal(event.feed, false);
  assert.deepEqual(event.actor, actor);
  assert.deepEqual(event.target, target);
  assert.equal(event.channelId, CHANNEL_ID);
  assert.deepEqual(event.fields, fields);
  assert.deepEqual(event.payload, payload);
});
