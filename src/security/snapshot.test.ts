import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Collection, type Guild, type Role } from "discord.js";
import { GUILD_ID, ROLE_ID, CHANNEL_ID, quietLogger } from "../testing/helpers.js";
import { SnapshotStore, captureSnapshot } from "./snapshot.js";

function fakeRole(
  id: string,
  name: string,
  position: number,
  managed = false,
): Role {
  return {
    id,
    name,
    color: 0xa77d42,
    hoist: true,
    mentionable: false,
    permissions: { bitfield: 1024n },
    position,
    managed,
  } as unknown as Role;
}

function fakeChannel(id: string, name: string, position: number): unknown {
  return {
    id,
    name,
    type: 0,
    parentId: null,
    position,
    topic: "the yard",
    nsfw: false,
    rateLimitPerUser: 5,
    bitrate: null,
    userLimit: null,
    permissionOverwrites: {
      cache: new Collection([
        [
          ROLE_ID,
          {
            id: ROLE_ID,
            type: 0,
            allow: { bitfield: 2048n },
            deny: { bitfield: 0n },
          },
        ],
      ]),
    },
  };
}

function fakeGuild(): Guild {
  const roles = new Collection<string, Role>([
    [GUILD_ID, fakeRole(GUILD_ID, "@everyone", 0)],
    [ROLE_ID, fakeRole(ROLE_ID, "Member", 1)],
    ["managed-role", fakeRole("managed-role", "Bot", 2, true)],
  ]);
  const channels = new Collection<string, unknown>([
    [CHANNEL_ID, fakeChannel(CHANNEL_ID, "general", 0)],
    ["channel-2", fakeChannel("channel-2", "workshop", 1)],
  ]);
  return {
    id: GUILD_ID,
    roles: { everyone: { id: GUILD_ID }, cache: roles },
    channels: { cache: channels },
  } as unknown as Guild;
}

test("captures roles and channels and round-trips through JSON", async () => {
  const snapshot = captureSnapshot(fakeGuild());
  assert.equal(snapshot.roles.length, 2);
  assert.equal(snapshot.channels.length, 2);
  assert.equal(snapshot.roles.find((role) => role.id === ROLE_ID)?.managed, false);
  assert.equal(snapshot.roles.find((role) => role.id === "managed-role")?.managed, true);
  assert.equal(snapshot.channels[0]?.overwrites[0]?.allow, "2048");

  const dir = await mkdtemp(join(tmpdir(), "wrightyard-snapshot-"));
  try {
    const store = new SnapshotStore({
      database: null,
      jsonPath: join(dir, "snapshot.json"),
      logger: quietLogger,
    });
    await store.save(snapshot);
    const loaded = await store.load(GUILD_ID);
    assert.equal(loaded?.guildId, GUILD_ID);
    assert.equal(loaded?.capturedAt.toISOString(), snapshot.capturedAt.toISOString());
    assert.equal(loaded?.channels[0]?.name, snapshot.channels[0]?.name);
    assert.equal(loaded?.roles.length, 2);
    assert.equal(await store.load("missing"), null);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saving a second snapshot replaces the first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-snapshot-"));
  try {
    const store = new SnapshotStore({
      database: null,
      jsonPath: join(dir, "snapshot.json"),
      logger: quietLogger,
    });
    const first = captureSnapshot(fakeGuild());
    await store.save(first);
    const second = { ...first, capturedAt: new Date() };
    await store.save(second);
    const loaded = await store.load(GUILD_ID);
    assert.equal(loaded?.capturedAt.toISOString(), second.capturedAt.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
