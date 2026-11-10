import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Collection, type Guild, type Role } from "discord.js";
import {
  CHANNEL_ID,
  GUILD_ID,
  ROLE_ID,
  FakeAudit,
  asAuditService,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import { SnapshotStore } from "./snapshot.js";
import { SnapshotService } from "./snapshot-service.js";

function fakeRole(id: string, name: string, position: number): Role {
  return {
    id,
    name,
    color: 0xa77d42,
    hoist: true,
    mentionable: false,
    permissions: { bitfield: 1024n },
    position,
    managed: false,
  } as unknown as Role;
}

function fakeGuild(): Guild {
  const roles = new Collection<string, Role>([
    [GUILD_ID, fakeRole(GUILD_ID, "@everyone", 0)],
    [ROLE_ID, fakeRole(ROLE_ID, "Member", 1)],
    ["staff-role", fakeRole("staff-role", "Staff", 2)],
  ]);
  const channels = new Collection<string, unknown>([
    [
      CHANNEL_ID,
      {
        id: CHANNEL_ID,
        name: "general",
        type: 0,
        parentId: null,
        position: 0,
        topic: "the yard",
        nsfw: false,
        rateLimitPerUser: 5,
        bitrate: null,
        userLimit: null,
        permissionOverwrites: { cache: new Collection() },
      },
    ],
    [
      "channel-2",
      {
        id: "channel-2",
        name: "workshop",
        type: 0,
        parentId: null,
        position: 1,
        topic: null,
        nsfw: false,
        rateLimitPerUser: 0,
        bitrate: null,
        userLimit: null,
        permissionOverwrites: { cache: new Collection() },
      },
    ],
  ]);
  return {
    id: GUILD_ID,
    roles: { everyone: { id: GUILD_ID }, cache: roles },
    channels: { cache: channels },
  } as unknown as Guild;
}

test("captures, saves, and records a snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-snapshot-service-"));
  try {
    const store = new SnapshotStore({
      database: null,
      jsonPath: join(dir, "snapshot.json"),
      logger: quietLogger,
    });
    const audit = new FakeAudit();
    const service = new SnapshotService({
      getGuild: () => fakeGuild(),
      store,
      audit: asAuditService(audit),
      config: makeConfig(),
      logger: quietLogger,
      intervalMs: 60_000,
    });

    assert.equal(service.last(), null);
    const snapshot = await service.captureNow();
    assert.equal(snapshot.roles.length, 2);
    assert.equal(snapshot.channels.length, 2);
    assert.equal(service.last()?.capturedAt.toISOString(), snapshot.capturedAt.toISOString());
    assert.equal(
      (await store.load(GUILD_ID))?.capturedAt.toISOString(),
      snapshot.capturedAt.toISOString(),
    );
    assert.ok(audit.events.some((event) => event.type === "security.snapshot"));
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureNow throws when the guild is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrightyard-snapshot-service-"));
  try {
    const store = new SnapshotStore({
      database: null,
      jsonPath: join(dir, "snapshot.json"),
      logger: quietLogger,
    });
    const service = new SnapshotService({
      getGuild: () => null,
      store,
      audit: asAuditService(new FakeAudit()),
      config: makeConfig(),
      logger: quietLogger,
      intervalMs: 60_000,
    });
    await assert.rejects(service.captureNow(), /Guild is not available/);
    assert.equal(service.last(), null);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
