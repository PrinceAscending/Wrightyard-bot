import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { BOT_ID, OWNER_ID, STAFF_ID, TARGET_ID, makeConfig } from "../testing/helpers.js";
import { canModerate, type ModerationGuardInput } from "./guard.js";

function base(overrides: Partial<ModerationGuardInput> = {}): ModerationGuardInput {
  return {
    actorId: STAFF_ID,
    actorRank: "moderator",
    actorPosition: 10,
    targetId: TARGET_ID,
    targetPosition: 1,
    targetIsBot: false,
    guildOwnerId: OWNER_ID,
    botId: BOT_ID,
    botPosition: 50,
    botPermissions: [],
    config: makeConfig(),
    minimumRank: "moderator",
    ...overrides,
  };
}

test("blocks self, owner, and the bot", () => {
  assert.equal(canModerate(base({ targetId: STAFF_ID })).ok, false);
  const owner = canModerate(base({ targetId: OWNER_ID }));
  assert.equal(owner.ok, false);
  assert.match(owner.ok ? "" : owner.reason, /owner/i);
  const bot = canModerate(base({ targetIsBot: true }));
  assert.equal(bot.ok, false);
  assert.match(bot.ok ? "" : bot.reason, /bot/i);
});

test("blocks equal or higher target roles", () => {
  const result = canModerate(base({ actorPosition: 10, targetPosition: 10 }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /hierarchy/i);
});

test("founder bypasses actor-side rank comparison", () => {
  const result = canModerate(
    base({ actorRank: "founder", actorPosition: 5, targetPosition: 10 }),
  );
  assert.equal(result.ok, true);
});

test("blocks when the bot is below the target", () => {
  const result = canModerate(base({ botPosition: 5, targetPosition: 10 }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /bot.*hierarchy/i);
});

test("blocks when the bot lacks the required permission", () => {
  const result = canModerate(
    base({
      requiredPermission: PermissionFlagsBits.ManageRoles,
      botPermissions: [],
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /permission/i);
});

test("passes when every check holds", () => {
  assert.equal(
    canModerate(
      base({
        requiredPermission: PermissionFlagsBits.ManageRoles,
        botPermissions: [PermissionFlagsBits.ManageRoles],
      }),
    ).ok,
    true,
  );
});

test("blocks ranks below the minimum", () => {
  const result = canModerate(base({ minimumRank: "steward" }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /steward/i);
});
