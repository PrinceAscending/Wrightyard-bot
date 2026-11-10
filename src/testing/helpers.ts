import type { Config } from "../config.js";
import type { Client, Guild, GuildMember } from "discord.js";
import type { Logger } from "../logger.js";

export const GUILD_ID = "1566778873985892442";
export const BOT_ID = "1566784935342252032";
export const OWNER_ID = "971329961313046578";
export const USER_ID = "1567000000000000001";
export const STAFF_ID = "1567000000000000002";
export const ACTOR_ID = "1567000000000000003";
export const TARGET_ID = "1567000000000000004";
export const CHANNEL_ID = "1567000000000000005";
export const CATEGORY_ID = "1567000000000000006";
export const MESSAGE_LOG_ID = "1567000000000000007";
export const ROLE_ID = "1567000000000000008";
export const STAFF_ROLE_ID = "1567000000000000009";
export const MOD_ID = "1567000000000000010";
export const STEWARD_ID = "1567000000000000011";
export const ADMIN_ID = "1567000000000000012";
export const QUARANTINE_ID = "1567000000000000013";
export const TRUSTED_ID = "1567000000000000014";
export const AUTHOR_ID = "1567000000000000015";
export const OTHER_ID = "1567000000000000016";
export const EVERYONE_ID = GUILD_ID;

export const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "test-token",
    clientId: BOT_ID,
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    siteUrl: null,
    heartbeatSecret: null,
    announcementsChannelId: null,
    ticketPanelChannelId: null,
    ticketLogChannelId: null,
    staffRoleIds: [STAFF_ROLE_ID],
    ticketCategoryId: null,
    autoRoleIds: [],
    botAutoRoleIds: [],
    levelRoles: [],
    welcomeChannelId: null,
    levelUpChannelId: null,
    mongoUri: null,
    mongoDb: "wrightyard",
    groqApiKey: null,
    groqModel: "test",
    port: 8080,
    nodeEnv: "test",
    logCategoryId: CATEGORY_ID,
    logChannelId: null,
    messageLogChannelId: MESSAGE_LOG_ID,
    memberLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    securityLogChannelId: null,
    modLogChannelId: null,
    logMessageContent: true,
    auditRetentionDays: 0,
    staffModeratorRoleIds: [],
    staffStewardRoleIds: [],
    staffAdminRoleIds: [],
    staffFounderRoleIds: [],
    antiNukeEnabled: true,
    antiNukeMode: "quarantine",
    antiNukeTrustedUserIds: [],
    antiNukeQuarantineRoleId: QUARANTINE_ID,
    antiNukeRestore: true,
    raidGuardEnabled: true,
    raidJoinThreshold: 8,
    raidWindowSeconds: 60,
    raidMinAccountAgeDays: 7,
    raidModeMinutes: 10,
    snapshotIntervalMinutes: 360,
    ...overrides,
  };
}

export interface FakeMemberOptions {
  readonly id?: string;
  readonly roles?: readonly string[];
  readonly bot?: boolean;
  readonly joinedTimestamp?: number | null;
  readonly displayName?: string;
  readonly tag?: string;
}

export function makeMember(options: FakeMemberOptions = {}): GuildMember {
  const id = options.id ?? USER_ID;
  const tag = options.tag ?? "user#0001";
  const username = tag.split("#")[0] ?? "user";
  return {
    id,
    user: { id, bot: options.bot ?? false, tag, username },
    displayName: options.displayName ?? username,
    joinedTimestamp: options.joinedTimestamp ?? Date.now(),
    roles: {
      cache: new Map((options.roles ?? []).map((roleId) => [roleId, { id: roleId }])),
    },
  } as unknown as GuildMember;
}

export function fakeClient(guilds: Guild[] = []): Client {
  const stub = {
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    channels: { cache: new Map() },
    on: () => stub,
    once: () => stub,
    isReady: () => true,
  };
  return stub as unknown as Client;
}
