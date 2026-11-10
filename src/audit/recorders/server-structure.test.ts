import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, ROLE_ID } from "../../testing/helpers.js";
import {
  emojiEvents,
  guildUpdateEvents,
  inviteCreateEvent,
  roleCreateEvent,
  roleDeleteEvent,
  roleUpdateEvents,
  stickerEvents,
  type GuildSettingsLike,
  type RoleLike,
} from "./server-structure.js";

interface FakeRoleOptions {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
  position?: number;
}

function fakeRole(options: FakeRoleOptions = {}): RoleLike {
  return {
    id: ROLE_ID,
    name: options.name ?? "Admin",
    color: options.color ?? 0,
    hoist: options.hoist ?? false,
    mentionable: options.mentionable ?? false,
    position: options.position ?? 1,
    permissions: options.permissions ?? "0",
    managed: false,
  };
}

function fakeGuild(options: Partial<GuildSettingsLike> = {}): GuildSettingsLike {
  return {
    id: GUILD_ID,
    name: "Old",
    icon: null,
    banner: null,
    splash: null,
    verificationLevel: 1,
    explicitContentFilter: 0,
    afkChannelId: null,
    systemChannelId: null,
    preferredLocale: "en-US",
    ...options,
  };
}

function field(event: { fields?: { name: string; value: string }[] }, name: string): string {
  return event.fields?.find((entry) => entry.name === name)?.value ?? "";
}

test("role delete includes permissions for restore", () => {
  const event = roleDeleteEvent(
    fakeRole({ name: "Admin", permissions: "8" }),
    GUILD_ID,
    null,
  );
  assert.equal(event.type, "role.delete");
  assert.equal((event.payload as Record<string, unknown>).permissions, "8");
});

test("role create records presentation and permissions", () => {
  const event = roleCreateEvent(fakeRole({ name: "Helper", permissions: "1024" }), GUILD_ID, null);
  assert.equal(event.type, "role.create");
  assert.match(field(event, "Permissions"), /1024/);
});

test("role update separates permissions from presentation", () => {
  const events = roleUpdateEvents(
    fakeRole({ name: "Mod", color: 1, hoist: false, permissions: "1024" }),
    fakeRole({ name: "Mod", color: 2, hoist: true, permissions: "2048" }),
    GUILD_ID,
    null,
  );
  assert.ok(events.some((event) => event.type === "role.update"));
  assert.ok(events.some((event) => event.summary.includes("permissions")));
  assert.equal(events.length, 2);
});

test("role update returns nothing when unchanged", () => {
  assert.deepEqual(roleUpdateEvents(fakeRole(), fakeRole(), GUILD_ID, null), []);
});

test("guild update records name and verification level", () => {
  const events = guildUpdateEvents(
    fakeGuild({ name: "Old", verificationLevel: 1 }),
    fakeGuild({ name: "New", verificationLevel: 3 }),
    GUILD_ID,
    null,
  );
  assert.equal(events[0]?.type, "guild.update");
  assert.match(events[0]?.fields?.map((entry) => entry.value).join(" ") ?? "", /Old/);
  assert.equal(events.length, 2);
});

test("emoji and sticker events use their kinds", () => {
  const emoji = emojiEvents("delete", { id: "1", name: "wave", animated: true }, GUILD_ID, null);
  assert.equal(emoji.type, "emoji.delete");
  assert.equal(emoji.severity, "warn");
  const sticker = stickerEvents("update", { id: "2", name: "ship", tags: "boat" }, GUILD_ID, null);
  assert.equal(sticker.type, "sticker.update");
});

test("invite create includes code, channel, and uses", () => {
  const event = inviteCreateEvent(
    {
      code: "abc",
      channelId: "1567000000000000005",
      inviter: { id: "1567000000000000003", tag: "actor#0001" },
      uses: 0,
      maxAge: 86400,
      maxUses: 0,
      temporary: false,
    },
    GUILD_ID,
    null,
  );
  assert.equal(event.type, "invite.create");
  assert.match(field(event, "Code"), /abc/);
  assert.equal(event.actor?.tag, "actor#0001");
});
