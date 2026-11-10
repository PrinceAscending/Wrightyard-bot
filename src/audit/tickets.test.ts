import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_ID, STAFF_ID, USER_ID } from "../testing/helpers.js";
import { ticketAuditEvent } from "./tickets.js";

test("ticket close event records the actor", () => {
  const event = ticketAuditEvent({
    action: "close",
    ticketNumber: 4,
    channelId: CHANNEL_ID,
    actorId: STAFF_ID,
    openerId: USER_ID,
  });
  assert.equal(event.type, "ticket.close");
  assert.equal(event.actor?.id, STAFF_ID);
});

test("ticket delete is a warning", () => {
  const event = ticketAuditEvent({
    action: "delete",
    ticketNumber: 4,
    channelId: CHANNEL_ID,
    actorId: STAFF_ID,
    openerId: USER_ID,
  });
  assert.equal(event.severity, "warn");
});

test("ticket open records the opener as actor", () => {
  const event = ticketAuditEvent({
    action: "open",
    ticketNumber: 1,
    channelId: CHANNEL_ID,
    actorId: USER_ID,
    openerId: USER_ID,
  });
  assert.equal(event.type, "ticket.open");
  assert.equal(event.actor?.id, USER_ID);
});
