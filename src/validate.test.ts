import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PermissionFlagsBits,
  type Client,
  type Guild,
} from "discord.js";
import type { Logger } from "./logger.js";
import {
  GUILD_ID,
  MESSAGE_LOG_ID,
  OWNER_ID,
  QUARANTINE_ID,
  makeConfig,
  quietLogger,
} from "./testing/helpers.js";
import { REQUIRED_PERMISSIONS, validateGuildConfiguration } from "./validate.js";

function captureLogger(): { warnings: string[]; logger: Logger } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      ...quietLogger,
      warn: (message: string) => {
        warnings.push(message);
      },
    } as unknown as Logger,
  };
}

function fakeClient(options: {
  missingPermissions?: readonly bigint[];
  roles?: readonly string[];
  channels?: readonly string[];
} = {}): Client {
  const missing = new Set(options.missingPermissions ?? []);
  const guild = {
    id: GUILD_ID,
    name: "Wrightyard.",
    memberCount: 4,
    channels: {
      cache: new Map((options.channels ?? []).map((id) => [id, { id, type: 0 }])),
    },
    roles: {
      cache: new Map((options.roles ?? []).map((id) => [id, { id }])),
    },
    members: {
      fetch: async () => ({ id: OWNER_ID }),
      me: {
        permissions: {
          has: (permission: bigint) => !missing.has(permission),
        },
      },
    },
  };
  return {
    guilds: { cache: new Map([[GUILD_ID, guild as unknown as Guild]]) },
  } as unknown as Client;
}

function quietConfig() {
  return makeConfig({
    announcementsChannelId: null,
    ticketPanelChannelId: null,
    ticketLogChannelId: null,
    ticketCategoryId: null,
    welcomeChannelId: null,
    levelUpChannelId: null,
    staffRoleIds: [],
    autoRoleIds: [],
    botAutoRoleIds: [],
    levelRoles: [],
    logCategoryId: null,
    logChannelId: null,
    messageLogChannelId: null,
    memberLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    securityLogChannelId: null,
    modLogChannelId: null,
    antiNukeQuarantineRoleId: null,
  });
}

test("requires audit and moderation permissions", () => {
  for (const permission of [
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ManageGuildExpressions,
  ]) {
    assert.ok(REQUIRED_PERMISSIONS.includes(permission));
  }
});

test("warns about every missing permission", async () => {
  const { logger, warnings } = captureLogger();
  await validateGuildConfiguration(
    fakeClient({ missingPermissions: [PermissionFlagsBits.ViewAuditLog] }),
    quietConfig(),
    logger,
  );
  assert.ok(warnings.some((warning) => /missing permissions/i.test(warning)));
});

test("warns when configured channels and the quarantine role are absent", async () => {
  const { logger, warnings } = captureLogger();
  await validateGuildConfiguration(
    fakeClient(),
    makeConfig({
      ...quietConfig(),
      messageLogChannelId: MESSAGE_LOG_ID,
      antiNukeQuarantineRoleId: QUARANTINE_ID,
    }),
    logger,
  );
  assert.ok(warnings.some((warning) => /message log channel/i.test(warning)));
  assert.ok(warnings.some((warning) => /quarantine role/i.test(warning)));
});

test("a fully permissioned bot with no optional IDs is quiet", async () => {
  const { logger, warnings } = captureLogger();
  await validateGuildConfiguration(fakeClient(), quietConfig(), logger);
  assert.deepEqual(warnings, []);
});
