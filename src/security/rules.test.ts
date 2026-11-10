import assert from "node:assert/strict";
import { test } from "node:test";
import type { DestructiveKind, ObservedAction } from "./types.js";
import { SECURITY_RULES, evaluateSecurity } from "./rules.js";

const GUILD_ID = "123456789012345678";
const ACTOR_ID = "223456789012345678";

function makeAction(kind: DestructiveKind, at: Date): ObservedAction {
  return {
    kind,
    guildId: GUILD_ID,
    actorId: ACTOR_ID,
    actorTag: "actor#0001",
    targetId: "323456789012345678",
    targetName: "target",
    at,
  };
}

test("three channel deletes in the window quarantine", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = [0, 1, 2].map((offset) =>
    makeAction("channelDelete", new Date(now.getTime() - offset * 1_000)),
  );
  assert.equal(evaluateSecurity(actions, now, "quarantine").action, "quarantine");
});

test("ban mode escalates at six channel deletes", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = Array.from({ length: 6 }, (_, index) =>
    makeAction("channelDelete", new Date(now.getTime() - index * 1_000)),
  );
  assert.equal(evaluateSecurity(actions, now, "quarantine").action, "quarantine");
  assert.equal(evaluateSecurity(actions, now, "ban").action, "ban");
});

test("alert mode never punishes", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = Array.from({ length: 10 }, (_, index) =>
    makeAction("channelDelete", new Date(now.getTime() - index * 1_000)),
  );
  const decision = evaluateSecurity(actions, now, "alert");
  assert.equal(decision.action, "alert");
  assert.equal(decision.count, 10);
  assert.equal(decision.kind, "channelDelete");
});

test("old actions fall out of the window", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = [0, 1, 2].map((offset) =>
    makeAction("channelDelete", new Date(now.getTime() - 120_000 - offset * 1_000)),
  );
  assert.equal(evaluateSecurity(actions, now, "quarantine").action, "none");
});

test("guild updates use the 300 second window", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = [0, 100_000].map((offset) =>
    makeAction("guildUpdate", new Date(now.getTime() - offset)),
  );
  assert.equal(evaluateSecurity(actions, now, "quarantine").action, "quarantine");
});

test("the highest severity across kinds wins", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = [
    makeAction("channelDelete", now),
    makeAction("guildUpdate", new Date(now.getTime() - 1_000)),
    makeAction("guildUpdate", new Date(now.getTime() - 2_000)),
    makeAction("guildUpdate", new Date(now.getTime() - 3_000)),
  ];
  const decision = evaluateSecurity(actions, now, "ban");
  assert.equal(decision.action, "ban");
  assert.equal(decision.kind, "guildUpdate");
  assert.equal(decision.count, 3);
});

test("severity ties keep the earlier rule", () => {
  const now = new Date("2026-11-09T00:00:00Z");
  const actions = [
    makeAction("channelDelete", now),
    makeAction("channelDelete", new Date(now.getTime() - 1_000)),
    makeAction("roleDelete", now),
    makeAction("roleDelete", new Date(now.getTime() - 1_000)),
  ];
  const decision = evaluateSecurity(actions, now, "quarantine");
  assert.equal(decision.action, "alert");
  assert.equal(decision.kind, "channelDelete");
  assert.equal(SECURITY_RULES.length, 14);
});
