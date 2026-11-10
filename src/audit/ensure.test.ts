import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import {
  BOT_ID,
  CATEGORY_ID,
  CHANNEL_ID,
  GUILD_ID,
  MESSAGE_LOG_ID,
  OWNER_ID,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import { ensureAuditChannels } from "./ensure.js";

interface CreatedChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly topic?: string;
}

interface FakeGuild {
  readonly guild: Guild;
  readonly createdChannels: CreatedChannel[];
}

function channel(
  id: string,
  name: string,
  type: number,
  parentId: string | null = null,
): GuildBasedChannel {
  return {
    id,
    name,
    type,
    parentId,
    permissionOverwrites: { cache: new Collection() },
  } as unknown as GuildBasedChannel;
}

function fakeGuild(options: {
  existingChannels?: readonly GuildBasedChannel[];
  existingCategory?: GuildBasedChannel | null;
  canManage?: boolean;
  failCreate?: boolean;
} = {}): FakeGuild {
  const channels = new Collection<string, GuildBasedChannel>();
  for (const entry of options.existingChannels ?? []) {
    channels.set(entry.id, entry);
  }
  if (options.existingCategory) {
    channels.set(options.existingCategory.id, options.existingCategory);
  }
  const createdChannels: CreatedChannel[] = [];
  let categoryCount = 0;
  let channelCount = 0;

  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    client: { user: { id: BOT_ID } },
    members: {
      me: {
        id: BOT_ID,
        permissions: {
          has: (permission: bigint) =>
            (options.canManage ?? true) && permission === PermissionFlagsBits.ManageChannels,
        },
      },
    },
    channels: {
      cache: channels,
      create: async (input: {
        name: string;
        type: number;
        parent?: string;
        topic?: string;
      }) => {
        if (options.failCreate) {
          throw new Error("Missing Access");
        }
        const isCategory = input.type === ChannelType.GuildCategory;
        const id = isCategory
          ? categoryCount++ === 0
            ? CATEGORY_ID
            : `audit-category-${categoryCount}`
          : `audit-channel-${++channelCount}`;
        const created = {
          id,
          name: input.name,
          type: input.type,
          parentId: input.parent ?? null,
          topic: input.topic,
        };
        createdChannels.push(created);
        channels.set(id, channel(id, input.name, input.type, created.parentId));
        return channels.get(id);
      },
    },
  };

  return { guild: guild as unknown as Guild, createdChannels };
}

function withoutConfiguredChannels() {
  return makeConfig({
    logCategoryId: null,
    logChannelId: null,
    messageLogChannelId: null,
    memberLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    securityLogChannelId: null,
    modLogChannelId: null,
    ticketLogChannelId: null,
  });
}

test("creates missing log channels under the audit category", async () => {
  const fake = fakeGuild({
    existingChannels: [
      channel(MESSAGE_LOG_ID, "log-messages", ChannelType.GuildText),
    ],
    existingCategory: null,
  });
  const result = await ensureAuditChannels(fake.guild, makeConfig(), quietLogger);
  assert.equal(result.categoryId, CATEGORY_ID);
  assert.equal(result.created.includes("log-messages"), false);
  assert.ok(result.created.includes("log-members"));
  assert.equal(result.channels.get("message"), MESSAGE_LOG_ID);
  assert.equal(
    fake.createdChannels.filter((entry) => entry.parentId === CATEGORY_ID).length,
    5,
  );
  assert.equal(result.channels.get("automod"), result.channels.get("server"));
  assert.ok(result.warnings.some((warning) => /ticket/i.test(warning)));
});

test("reuses an existing audit category and named channels", async () => {
  const existingCategory = channel(
    "existing-category",
    "audit",
    ChannelType.GuildCategory,
  );
  const existingChannels = [
    channel(MESSAGE_LOG_ID, "log-messages", ChannelType.GuildText, "existing-category"),
    channel("member-log", "log-members", ChannelType.GuildText, "existing-category"),
    channel("server-log", "log-server", ChannelType.GuildText, "existing-category"),
    channel("voice-log", "log-voice", ChannelType.GuildText, "existing-category"),
    channel("security-log", "log-security", ChannelType.GuildText, "existing-category"),
    channel("mod-log", "mod-log", ChannelType.GuildText, "existing-category"),
    channel("tickets", "tickets", ChannelType.GuildText),
  ];
  const fake = fakeGuild({
    existingCategory,
    existingChannels,
  });
  const result = await ensureAuditChannels(
    fake.guild,
    withoutConfiguredChannels(),
    quietLogger,
  );
  assert.equal(result.categoryId, "existing-category");
  assert.equal(result.created.length, 0);
  assert.equal(result.channels.get("message"), MESSAGE_LOG_ID);
  assert.equal(result.channels.get("member"), "member-log");
  assert.equal(result.channels.get("server"), "server-log");
  assert.equal(result.channels.get("voice"), "voice-log");
  assert.equal(result.channels.get("security"), "security-log");
  assert.equal(result.channels.get("moderation"), "mod-log");
  assert.equal(result.channels.get("ticket"), "tickets");
  assert.equal(result.channels.get("automod"), "server-log");
  assert.equal(fake.createdChannels.length, 0);
});

test("without Manage Channels it only returns configured channels", async () => {
  const fake = fakeGuild({
    canManage: false,
    existingChannels: [
      channel(MESSAGE_LOG_ID, "log-messages", ChannelType.GuildText),
    ],
  });
  const result = await ensureAuditChannels(fake.guild, makeConfig(), quietLogger);
  assert.equal(result.channels.get("message"), MESSAGE_LOG_ID);
  assert.equal(result.channels.get("member"), undefined);
  assert.equal(result.created.length, 0);
  assert.equal(fake.createdChannels.length, 0);
  assert.ok(result.warnings.some((warning) => /Manage Channels/i.test(warning)));
});

test("LOG_CHANNEL_ID is a fallback instead of creating channels", async () => {
  const fallback = channel(CHANNEL_ID, "log", ChannelType.GuildText);
  const fake = fakeGuild({ existingChannels: [fallback] });
  const result = await ensureAuditChannels(
    fake.guild,
    { ...withoutConfiguredChannels(), logChannelId: CHANNEL_ID },
    quietLogger,
  );
  assert.equal(result.created.length, 0);
  for (const category of [
    "message",
    "member",
    "server",
    "voice",
    "security",
    "moderation",
  ] as const) {
    assert.equal(result.channels.get(category), CHANNEL_ID);
  }
});

test("provisioning never throws when Discord rejects creation", async () => {
  const fake = fakeGuild({ failCreate: true });
  const result = await ensureAuditChannels(fake.guild, makeConfig(), quietLogger);
  assert.equal(result.created.length, 0);
  assert.ok(result.warnings.length > 0);
});
