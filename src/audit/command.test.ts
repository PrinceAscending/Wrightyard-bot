import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, USER_ID } from "../testing/helpers.js";
import { commandAuditEvent } from "./command.js";

test("command success is archive only", () => {
  const event = commandAuditEvent({
    command: "status",
    userId: USER_ID,
    guildId: GUILD_ID,
    durationMs: 42,
  });
  assert.equal(event.type, "command.served");
  assert.equal(event.feed, false);
});

test("command failure carries the error name", () => {
  const event = commandAuditEvent({
    command: "ask",
    userId: USER_ID,
    guildId: GUILD_ID,
    durationMs: 99,
    error: new Error("boom"),
  });
  assert.equal(event.type, "command.failed");
  assert.match(event.fields?.map((field) => field.value).join(" ") ?? "", /Error/);
});
