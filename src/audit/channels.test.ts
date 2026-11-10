import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  BOT_ID,
  GUILD_ID,
  MESSAGE_LOG_ID,
  OWNER_ID,
  STAFF_ROLE_ID,
  makeConfig,
} from "../testing/helpers.js";
import {
  auditOverwritePlan,
  logChannelName,
  planAuditChannelCreations,
} from "./channels.js";

test("maps categories to channel names", () => {
  assert.equal(logChannelName("message"), "log-messages");
  assert.equal(logChannelName("member"), "log-members");
  assert.equal(logChannelName("moderation"), "mod-log");
  assert.equal(logChannelName("ticket"), "tickets");
  assert.equal(logChannelName("automod"), "log-server");
  assert.equal(logChannelName("command"), null);
  assert.equal(logChannelName("lifecycle"), null);
});

test("denies everyone and allows the bot, staff, and owner", () => {
  const plan = auditOverwritePlan({
    guildId: GUILD_ID,
    botId: BOT_ID,
    ownerId: OWNER_ID,
    staffRoleIds: [STAFF_ROLE_ID],
  });
  assert.equal(plan.length, 4);
  assert.deepEqual(plan[0]?.deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(plan[1]?.id, BOT_ID);
  assert.equal(plan[2]?.id, OWNER_ID);
  assert.equal(plan[3]?.id, STAFF_ROLE_ID);
});

test("plans creation only for missing, unconfigured channels", () => {
  const names = planAuditChannelCreations([], makeConfig({ messageLogChannelId: null }));
  assert.deepEqual(names, [
    "log-messages",
    "log-members",
    "log-server",
    "log-voice",
    "log-security",
    "mod-log",
  ]);

  const partial = planAuditChannelCreations(
    ["log-messages", "mod-log"],
    makeConfig({ logChannelId: null }),
  );
  assert.deepEqual(partial, ["log-members", "log-server", "log-voice", "log-security"]);

  assert.deepEqual(
    planAuditChannelCreations([], makeConfig({ logChannelId: MESSAGE_LOG_ID })),
    [],
  );
});
