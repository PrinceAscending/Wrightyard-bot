import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildMember } from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { LevelStore } from "./levels.js";
import { CommunityService } from "./community.js";

const GUILD_ID = "1566778873985892442";
const HUMAN_ROLE_ID = "1566787063687422062";
const BOT_ROLE_ID = "1569036599193510008";

function makeConfig(): Config {
  return {
    token: "test-token",
    clientId: "1566784935342252032",
    guildId: GUILD_ID,
    ownerId: "971329961313046578",
    siteUrl: null,
    heartbeatSecret: null,
    announcementsChannelId: null,
    ticketPanelChannelId: null,
    ticketLogChannelId: null,
    staffRoleIds: [],
    ticketCategoryId: null,
    autoRoleIds: [HUMAN_ROLE_ID],
    botAutoRoleIds: [BOT_ROLE_ID],
    levelRoles: [],
    welcomeChannelId: null,
    levelUpChannelId: null,
    mongoUri: null,
    mongoDb: "wrightyard",
    groqApiKey: null,
    groqModel: "test",
    port: 8080,
    nodeEnv: "test",
  } as unknown as Config;
}

function makeMember(bot: boolean): { member: GuildMember; added: string[][] } {
  const added: string[][] = [];
  const member = {
    id: bot ? "1566784935342252032" : "1060963001718550528",
    guild: {
      id: GUILD_ID,
      roles: {
        cache: new Map([
          [HUMAN_ROLE_ID, { id: HUMAN_ROLE_ID, name: "Crew" }],
          [BOT_ROLE_ID, { id: BOT_ROLE_ID, name: "TrueForce" }],
        ]),
      },
      channels: {
        cache: {
          get: () => undefined,
          find: () => undefined,
        },
        fetch: async () => null,
      },
      members: { me: null },
    },
    user: { bot },
    roles: {
      add: async (roleIds: string | string[]) => {
        added.push(Array.isArray(roleIds) ? roleIds : [roleIds]);
      },
    },
  } as unknown as GuildMember;

  return { member, added };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as Logger;

test("gives a joining bot the configured bot role", async () => {
  const { member, added } = makeMember(true);
  const service = new CommunityService(makeConfig(), {} as LevelStore, logger);

  await service.onMemberJoin(member);

  assert.deepEqual(added, [[BOT_ROLE_ID]]);
});

test("gives a joining human the configured human role", async () => {
  const { member, added } = makeMember(false);
  const service = new CommunityService(makeConfig(), {} as LevelStore, logger);

  await service.onMemberJoin(member);

  assert.deepEqual(added, [[HUMAN_ROLE_ID]]);
});
