import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChannelType,
  Collection,
  OverwriteType,
  type Guild,
  type GuildBasedChannel,
  type Role,
} from "discord.js";
import {
  ACTOR_ID,
  FakeAudit,
  GUILD_ID,
  ROLE_ID,
  asAuditService,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import type { DestructiveKind, ObservedAction } from "./types.js";
import { SnapshotStore } from "./snapshot.js";
import {
  RestoreService,
  planRestoreOrder,
  remapOverwrites,
  type OverwritePlan,
} from "./restore.js";

const OLD_ROLE_ID = "old-role";
const OLD_CHANNEL_ID = "old-channel";
const OLD_CATEGORY_ID = "old-category";
const NEW_ROLE_ID = "new-role";
const NOW = new Date("2026-11-09T00:00:00Z");

interface FakeRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  readonly position: number;
  readonly managed: boolean;
  readonly permissions: string;
}

interface FakeChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly position: number;
  readonly topic: string | null;
  readonly nsfw: boolean;
  readonly rateLimitPerUser: number;
  readonly bitrate: number | null;
  readonly userLimit: number | null;
  readonly overwrites: readonly {
    readonly id: string;
    readonly type: number;
    readonly allow: bigint;
    readonly deny: bigint;
  }[];
}

function fakeRole(overrides: Partial<FakeRole> = {}): FakeRole {
  return {
    id: OLD_ROLE_ID,
    name: "Helper",
    color: 0xa77d42,
    hoist: true,
    mentionable: false,
    position: 5,
    managed: false,
    permissions: "1024",
    ...overrides,
  };
}

function fakeChannel(overrides: Partial<FakeChannel> = {}): FakeChannel {
  return {
    id: OLD_CHANNEL_ID,
    name: "workshop",
    type: ChannelType.GuildText,
    parentId: null,
    position: 0,
    topic: "the yard",
    nsfw: false,
    rateLimitPerUser: 5,
    bitrate: null,
    userLimit: null,
    overwrites: [
      { id: OLD_ROLE_ID, type: OverwriteType.Role, allow: 2048n, deny: 0n },
    ],
    ...overrides,
  };
}

interface CreatedChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly overwrites: readonly { id: string; type: number; allow: bigint; deny: bigint }[];
  position: number;
}

interface FakeGuild {
  readonly guild: Guild;
  readonly rolesCreated: FakeRole[];
  readonly channelsCreated: CreatedChannel[];
}

function fakeGuild(
  options: {
    readonly roles?: readonly FakeRole[];
    readonly channels?: readonly FakeChannel[];
  } = {},
): FakeGuild {
  const roles = new Collection<string, Role>();
  const channels = new Collection<string, GuildBasedChannel>();
  const rolesCreated: FakeRole[] = [];
  const channelsCreated: CreatedChannel[] = [];
  let roleSequence = 1;
  let channelSequence = 1;

  for (const role of options.roles ?? []) {
    roles.set(role.id, { ...role } as unknown as Role);
  }
  for (const channel of options.channels ?? []) {
    channels.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      permissionOverwrites: { cache: new Collection() },
    } as unknown as GuildBasedChannel);
  }

  const guild = {
    id: GUILD_ID,
    roles: {
      cache: roles,
      create: async (input: {
        name: string;
        colors: { primaryColor: number };
        hoist: boolean;
        mentionable: boolean;
        permissions: bigint;
      }) => {
        const created: FakeRole = {
          id: `restored-role-${roleSequence++}`,
          name: input.name,
          color: input.colors.primaryColor,
          hoist: input.hoist,
          mentionable: input.mentionable,
          position: 0,
          managed: false,
          permissions: input.permissions.toString(),
        };
        rolesCreated.push(created);
        roles.set(
          created.id,
          {
            ...created,
            setPosition: async (position: number) => {
              (created as { position: number }).position = position;
            },
          } as unknown as Role,
        );
        return roles.get(created.id);
      },
    },
    channels: {
      cache: channels,
      create: async (input: {
        name: string;
        type: number;
        parent?: string;
        permissionOverwrites?: readonly {
          id: string;
          type: number;
          allow: bigint;
          deny: bigint;
        }[];
      }) => {
        const created: CreatedChannel = {
          id: `restored-channel-${channelSequence++}`,
          name: input.name,
          type: input.type,
          parentId: input.parent ?? null,
          overwrites: [...(input.permissionOverwrites ?? [])],
          position: 0,
        };
        channelsCreated.push(created);
        channels.set(
          created.id,
          {
            ...created,
            setPosition: async (position: number) => {
              created.position = position;
            },
          } as unknown as GuildBasedChannel,
        );
        return channels.get(created.id);
      },
    },
    members: {
      me: {
        roles: { highest: { position: 100 } },
      },
    },
  };

  return {
    guild: guild as unknown as Guild,
    rolesCreated,
    channelsCreated,
  };
}

function makeAction(
  kind: DestructiveKind,
  payload: FakeRole | FakeChannel,
  now = NOW,
): ObservedAction {
  return {
    kind,
    guildId: GUILD_ID,
    actorId: ACTOR_ID,
    actorTag: "actor#0001",
    targetId: payload.id,
    targetName: payload.name,
    at: now,
    payload,
  };
}

async function makeService(fake: FakeGuild): Promise<{
  service: RestoreService;
  audit: FakeAudit;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-restore-"));
  const store = new SnapshotStore({
    database: null,
    jsonPath: join(dir, "snapshot.json"),
    logger: quietLogger,
  });
  const audit = new FakeAudit();
  const service = new RestoreService({
    client: fakeClient([fake.guild]),
    config: makeConfig(),
    snapshotStore: store,
    audit: asAuditService(audit),
    logger: quietLogger,
  });
  return { service, audit, dir };
}

test("restores roles before categories before channels before threads", () => {
  const ordered = planRestoreOrder([
    { kind: "channel", id: "c", position: 0 },
    { kind: "role", id: "r", position: 5 },
    { kind: "category", id: "g", position: 0 },
    { kind: "thread", id: "t", position: 0 },
  ]);
  assert.deepEqual(
    ordered.map((item) => item.kind),
    ["role", "category", "channel", "thread"],
  );
});

test("remaps overwrites for restored roles", () => {
  const mapped = remapOverwrites(
    [{ id: OLD_ROLE_ID, type: "role", allow: 8n, deny: 0n }],
    new Map([[OLD_ROLE_ID, NEW_ROLE_ID]]),
  );
  assert.equal(mapped[0]?.id, NEW_ROLE_ID);
  assert.equal(mapped[0]?.allow, 8n);
});

test("managed roles are not recreated", async () => {
  const fake = fakeGuild();
  const { service, audit, dir } = await makeService(fake);
  try {
    const result = await service.restoreRole(fakeRole({ managed: true }), "anti-nuke");
    assert.equal(result.restoredId, null);
    assert.match(result.note, /managed/i);
    assert.equal(fake.rolesCreated.length, 0);
    assert.ok(audit.events.some((event) => event.type === "security.restore"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreIncident restores roles before channels and remaps overwrites", async () => {
  const fake = fakeGuild();
  const { service, audit, dir } = await makeService(fake);
  try {
    const result = await service.restoreIncident(
      [
        makeAction("channelDelete", fakeChannel()),
        makeAction("roleDelete", fakeRole()),
      ],
      "anti-nuke",
    );

    assert.deepEqual(
      result.map((entry) => entry.kind),
      ["role", "channel"],
    );
    assert.equal(fake.rolesCreated.length, 1);
    assert.equal(fake.channelsCreated.length, 1);

    const createdRole = fake.rolesCreated[0];
    const createdChannel = fake.channelsCreated[0];
    assert.ok(createdRole);
    assert.ok(createdChannel);
    assert.equal(createdChannel.overwrites[0]?.id, createdRole.id);
    assert.equal(createdChannel.overwrites[0]?.type, OverwriteType.Role);
    assert.equal(createdChannel.overwrites[0]?.allow, 2048n);
    assert.ok(
      audit.events.some(
        (event) =>
          event.type === "security.restore" &&
          (event.payload as { restored?: number } | undefined)?.restored === 2,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restores a category before its child channel and parents the child", async () => {
  const fake = fakeGuild();
  const { service, dir } = await makeService(fake);
  try {
    const category = fakeChannel({
      id: OLD_CATEGORY_ID,
      name: "Workshop",
      type: ChannelType.GuildCategory,
      position: 2,
    });
    const child = fakeChannel({
      id: OLD_CHANNEL_ID,
      parentId: OLD_CATEGORY_ID,
    });
    const result = await service.restoreIncident(
      [
        makeAction("channelDelete", child),
        makeAction("channelDelete", category),
      ],
      "anti-nuke",
    );

    assert.equal(result.length, 2);
    const createdCategory = fake.channelsCreated.find(
      (entry) => entry.type === ChannelType.GuildCategory,
    );
    const createdChild = fake.channelsCreated.find(
      (entry) => entry.type === ChannelType.GuildText,
    );
    assert.ok(createdCategory);
    assert.ok(createdChild);
    assert.equal(createdChild.parentId, createdCategory.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adds a suffix when the original name is taken", async () => {
  const fake = fakeGuild({
    roles: [{ ...fakeRole(), id: ROLE_ID }],
    channels: [
      {
        ...fakeChannel(),
        id: "existing-channel",
      },
    ],
  });
  const { service, dir } = await makeService(fake);
  try {
    const role = await service.restoreRole(fakeRole(), "anti-nuke");
    const channel = await service.restoreChannel(fakeChannel(), "anti-nuke");
    assert.equal(fake.rolesCreated[0]?.name, "Helper-restored");
    assert.equal(fake.channelsCreated[0]?.name, "workshop-restored");
    assert.ok(role.restoredId);
    assert.ok(channel.restoredId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("threads report that their parent message is required", async () => {
  const fake = fakeGuild();
  const { service, dir } = await makeService(fake);
  try {
    const result = await service.restoreChannel(
      fakeChannel({ id: "thread", type: ChannelType.PublicThread }),
      "anti-nuke",
    );
    assert.equal(result.restoredId, null);
    assert.match(result.note, /parent message/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
