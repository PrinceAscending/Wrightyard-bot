import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_ID, CHANNEL_ID, GUILD_ID } from "../../testing/helpers.js";
import {
  automodExecutionEvent,
  automodRuleEvent,
  type AutomodExecutionLike,
  type AutomodRuleChange,
} from "./automod.js";

function fakeAutomod(overrides: Partial<AutomodExecutionLike> = {}): AutomodExecutionLike {
  return {
    ruleId: "1567000000000000300",
    ruleName: "Invite spam",
    ruleTriggerType: 1,
    action: "Block message",
    channelId: CHANNEL_ID,
    ...overrides,
  };
}

function fakeAutomodRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "1567000000000000300",
    name: "Invite spam",
    enabled: true,
    triggerType: 1,
    actions: [{ type: 1 }],
    exemptRoles: { size: 1 },
    exemptChannels: { size: 2 },
    ...overrides,
  };
}

test("automod execution records rule and action", () => {
  const event = automodExecutionEvent(fakeAutomod(), GUILD_ID);
  assert.equal(event.type, "automod.execution");
  assert.match(event.summary, /Invite spam/);
  assert.equal(event.category, "automod");
});

test("automod rule update records the rule and actor", () => {
  const event = automodRuleEvent(
    "update" satisfies AutomodRuleChange,
    fakeAutomodRule(),
    GUILD_ID,
    { id: ACTOR_ID, tag: "mod#0001" },
  );
  assert.equal(event.type, "automod.ruleUpdate");
  assert.match(event.summary, /Invite spam/);
  assert.equal(event.actor?.id, ACTOR_ID);
});

test("automod rule kinds map to distinct event types", () => {
  const created = automodRuleEvent("create", fakeAutomodRule(), GUILD_ID, null);
  const deleted = automodRuleEvent("delete", fakeAutomodRule(), GUILD_ID, null);
  assert.equal(created.type, "automod.ruleCreate");
  assert.equal(deleted.type, "automod.ruleDelete");
  assert.equal(deleted.severity, "warn");
});
