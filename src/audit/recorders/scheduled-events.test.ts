import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, USER_ID } from "../../testing/helpers.js";
import {
  scheduledEventEvent,
  type ScheduledEventLike,
} from "./scheduled-events.js";

function fakeScheduledEvent(overrides: Partial<ScheduledEventLike> = {}): ScheduledEventLike {
  return {
    id: "1567000000000000400",
    name: "Game night",
    guildId: GUILD_ID,
    description: "Bring snacks",
    scheduledStartTimestamp: Date.now() + 3_600_000,
    scheduledEndTimestamp: Date.now() + 7_200_000,
    status: 1,
    entityType: 3,
    channelId: "1567000000000000005",
    ...overrides,
  };
}

function fakeUser(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, tag: "user#0001", username: "user", ...overrides };
}

test("scheduled event create and user add are distinct", () => {
  const created = scheduledEventEvent("create", fakeScheduledEvent({ name: "Game night" }), GUILD_ID);
  assert.equal(created.type, "scheduledEvent.create");
  assert.match(created.summary, /Game night/);

  const joined = scheduledEventEvent(
    "userAdd",
    fakeScheduledEvent({ name: "Game night" }),
    GUILD_ID,
    fakeUser({ id: USER_ID }),
  );
  assert.equal(joined.type, "scheduledEvent.userAdd");
  assert.equal(joined.actor?.id, USER_ID);
});

test("scheduled event delete is a warning", () => {
  const event = scheduledEventEvent("delete", fakeScheduledEvent(), GUILD_ID);
  assert.equal(event.type, "scheduledEvent.delete");
  assert.equal(event.severity, "warn");
});

test("scheduled event fields include start, status, and entity", () => {
  const event = scheduledEventEvent("update", fakeScheduledEvent(), GUILD_ID);
  const values = event.fields?.map((entry) => entry.value).join(" ") ?? "";
  assert.match(values, /<t:/);
  assert.match(values, /Bring snacks/);
});
