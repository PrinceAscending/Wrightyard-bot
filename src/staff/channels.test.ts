import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import {
  CHANNEL_ID,
  EVERYONE_ID,
  FakeAudit,
  FakeCaseStore,
  GUILD_ID,
  MOD_ID,
  OWNER_ID,
  USER_ID,
  asAuditService,
  asCaseStore,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import { StaffGuardError } from "./actions.js";
import {
  StaffChannelActions,
  parsePurgeFilter,
  type PurgeMessageLike,
  type StaffChannelLike,
} from "./channels.js";

function makeActor(guild: Guild): GuildMember {
  return {
    id: USER_ID,
    guild,
    user: { id: USER_ID, tag: "moderator#0001", username: "moderator", bot: false },
    roles: {
      cache: new Map([[MOD_ID, { id: MOD_ID }]]),
      highest: { position: 50 },
    },
  } as unknown as GuildMember;
}

function makeGuild(): Guild {
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    roles: { everyone: { id: EVERYONE_ID } },
    members: {
      me: {
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
  } as unknown as Guild;
}

interface ChannelOptions {
  messages?: PurgeMessageLike[];
  allowed?: readonly bigint[];
  deleteFails?: boolean;
}

interface ChannelSpy {
  readonly channel: StaffChannelLike;
  readonly deleted: string[];
  readonly overwrites: Array<{ id: string; deny: bigint[]; neutral: bigint[] }>;
  readonly slowmodes: number[];
  fetchLimit: number;
}

const PERMISSION_NAMES: Record<string, bigint> = {
  SendMessages: PermissionFlagsBits.SendMessages,
};

function makeChannel(guild: Guild, options: ChannelOptions = {}): ChannelSpy {
  const deleted: string[] = [];
  const overwrites: Array<{ id: string; deny: bigint[]; neutral: bigint[] }> = [];
  const slowmodes: number[] = [];
  const allowed = options.allowed ?? [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageChannels,
  ];
  const spy: ChannelSpy = {
    deleted,
    overwrites,
    slowmodes,
    fetchLimit: 0,
    channel: {
      id: CHANNEL_ID,
      name: "general",
      guild,
      messages: {
        fetch: async ({ limit }: { limit: number }) => {
          spy.fetchLimit = limit;
          return new Map((options.messages ?? []).slice(0, limit).map((message) => [message.id, message]));
        },
        bulkDelete: async (ids: readonly string[]) => {
          if (options.deleteFails) {
            throw new Error("missing access");
          }
          deleted.push(...ids);
          return new Map();
        },
      },
      permissionOverwrites: {
        edit: async (target: unknown, changes: Record<string, boolean | null>) => {
          const deny: bigint[] = [];
          const neutral: bigint[] = [];
          for (const [name, value] of Object.entries(changes)) {
            const permission = PERMISSION_NAMES[name];
            if (!permission) {
              continue;
            }
            if (value === false) {
              deny.push(permission);
            } else if (value === null) {
              neutral.push(permission);
            }
          }
          overwrites.push({ id: (target as { id: string }).id, deny, neutral });
        },
      },
      permissionsFor: () => ({
        has: (permission: bigint) => allowed.includes(permission),
      }),
      setRateLimitPerUser: async (seconds: number) => {
        slowmodes.push(seconds);
      },
    } as unknown as StaffChannelLike,
  };
  return spy;
}

function makeActions() {
  const guild = makeGuild();
  const cases = new FakeCaseStore();
  const audit = new FakeAudit();
  const actions = new StaffChannelActions({
    client: fakeClient([guild]) as unknown as Client,
    config: makeConfig({ staffModeratorRoleIds: [MOD_ID] }),
    cases: asCaseStore(cases),
    audit: asAuditService(audit),
    logger: quietLogger,
  });
  return { actions, guild, cases, audit };
}

function message(
  id: string,
  authorId: string,
  content: string,
  ageMs = 0,
): PurgeMessageLike {
  return {
    id,
    content,
    author: { id: authorId },
    createdTimestamp: Date.now() - ageMs,
  };
}

test("purge filters by member and substring", async () => {
  const { actions, guild } = makeActions();
  const messages = [
    message("1", USER_ID, "hello"),
    message("2", "1567000000000000016", "hello"),
    message("3", USER_ID, "other"),
  ];
  const channel = makeChannel(guild, { messages });
  const result = await actions.purge(makeActor(guild), channel.channel, 50, {
    memberId: USER_ID,
    contains: "hello",
  });
  assert.deepEqual(result.deletedIds, ["1"]);
  assert.deepEqual(channel.deleted, ["1"]);
});

test("purge skips messages older than fourteen days", async () => {
  const { actions, guild } = makeActions();
  const messages = [message("1", USER_ID, "old", 15 * 86_400_000)];
  const channel = makeChannel(guild, { messages });
  const result = await actions.purge(makeActor(guild), channel.channel, 50);
  assert.deepEqual(result.deletedIds, []);
  assert.equal(result.skipped, 1);
  assert.deepEqual(channel.deleted, []);
});

test("purge clamps the fetch to one hundred messages", async () => {
  const { actions, guild } = makeActions();
  const channel = makeChannel(guild);
  await actions.purge(makeActor(guild), channel.channel, 500);
  assert.equal(channel.fetchLimit, 100);
});

test("lock denies SendMessages for everyone", async () => {
  const { actions, guild, cases } = makeActions();
  const channel = makeChannel(guild);
  await actions.lock(makeActor(guild), channel.channel);
  assert.deepEqual(channel.overwrites[0], {
    id: EVERYONE_ID,
    deny: [PermissionFlagsBits.SendMessages],
    neutral: [],
  });
  assert.equal(cases.records.at(-1)?.action, "lock");
  assert.equal(cases.records.at(-1)?.status, "closed");
});

test("unlock returns the everyone overwrite to neutral", async () => {
  const { actions, guild } = makeActions();
  const channel = makeChannel(guild);
  await actions.unlock(makeActor(guild), channel.channel);
  assert.deepEqual(channel.overwrites[0]?.neutral, [PermissionFlagsBits.SendMessages]);
});

test("slowmode enforces the Discord range", async () => {
  const { actions, guild } = makeActions();
  const channel = makeChannel(guild);
  await assert.rejects(() => actions.slowmode(makeActor(guild), channel.channel, 21_601), /21600/);
  await actions.slowmode(makeActor(guild), channel.channel, 10);
  assert.deepEqual(channel.slowmodes, [10]);
});

test("channel permission gaps block the action without a case", async () => {
  const { actions, guild, cases } = makeActions();
  const channel = makeChannel(guild, { allowed: [] });
  await assert.rejects(
    () => actions.lock(makeActor(guild), channel.channel),
    StaffGuardError,
  );
  assert.equal(cases.records.length, 0);
});

test("a purge failure records moderation.failed", async () => {
  const { actions, guild, cases, audit } = makeActions();
  const channel = makeChannel(guild, {
    messages: [message("1", USER_ID, "hello")],
    deleteFails: true,
  });
  await assert.rejects(() => actions.purge(makeActor(guild), channel.channel, 50), /missing access/);
  assert.equal(cases.records.length, 0);
  assert.equal(audit.events.at(-1)?.type, "moderation.failed");
});

test("parsePurgeFilter composes member and content checks", () => {
  const predicate = parsePurgeFilter({ memberId: USER_ID, contains: "HELLO" });
  assert.equal(predicate(message("1", USER_ID, "hello")), true);
  assert.equal(predicate(message("2", USER_ID, "nope")), false);
  assert.equal(predicate(message("3", "other", "hello")), false);
});
