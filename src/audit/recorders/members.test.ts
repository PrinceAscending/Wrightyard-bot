import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_ID, GUILD_ID, ROLE_ID, STAFF_ROLE_ID } from "../../testing/helpers.js";
import {
  memberBanEvent,
  memberJoinEvent,
  memberLeaveEvent,
  memberUpdateEvents,
  type MemberLike,
} from "./members.js";

interface FakeMemberOptions {
  bot?: boolean;
  ageDays?: number;
  roles?: string[];
  nick?: string | null;
  timeout?: boolean;
}

function fakeMember(options: FakeMemberOptions = {}): MemberLike {
  const roles = new Map((options.roles ?? []).map((id) => [id, { id }]));
  return {
    id: "1567000000000000123",
    user: {
      id: "1567000000000000123",
      tag: "member#0001",
      username: "member",
      bot: options.bot ?? false,
      createdTimestamp: Date.now() - (options.ageDays ?? 1) * 86_400_000,
    },
    guildId: GUILD_ID,
    joinedTimestamp: Date.now() - 60_000,
    nickname: options.nick ?? null,
    communicationDisabledUntilTimestamp: options.timeout ? Date.now() + 60_000 : null,
    roles: { cache: roles as unknown as Map<string, { id: string }> },
    avatarURL: () => "https://cdn.example/avatar.png",
  } as unknown as MemberLike;
}

function field(event: { fields?: { name: string; value: string }[] }, name: string): string {
  return event.fields?.find((entry) => entry.name === name)?.value ?? "";
}

test("join records account age and bot flag", () => {
  const event = memberJoinEvent(fakeMember({ bot: true, ageDays: 400 }), GUILD_ID);
  assert.equal(event.type, "member.join");
  assert.match(field(event, "Account age"), /400/);
  assert.match(field(event, "Bot"), /yes/i);
});

test("leave becomes a kick when an actor is attributed", () => {
  const event = memberLeaveEvent(fakeMember({}), GUILD_ID, {
    id: ACTOR_ID,
    tag: "mod#0001",
  });
  assert.equal(event.type, "member.kick");
  assert.equal(event.actor?.id, ACTOR_ID);
});

test("leave without attribution stays a plain leave", () => {
  const event = memberLeaveEvent(fakeMember({}), GUILD_ID, null);
  assert.equal(event.type, "member.leave");
  assert.equal(event.actor, undefined);
});

test("update returns role and profile events separately", () => {
  const events = memberUpdateEvents(
    fakeMember({ roles: [ROLE_ID, STAFF_ROLE_ID], nick: "old", timeout: false }),
    fakeMember({ roles: [STAFF_ROLE_ID, "1567000000000000999"], nick: "new", timeout: true }),
    GUILD_ID,
    null,
  );
  assert.ok(events.some((event) => event.type === "member.roles"));
  assert.ok(events.some((event) => event.type === "member.update"));
  assert.deepEqual(events[0]?.payload, {
    added: ["1567000000000000999"],
    removed: [ROLE_ID],
    guildId: GUILD_ID,
  });
});

test("update returns nothing when nothing changed", () => {
  const member = fakeMember({ roles: [ROLE_ID], nick: "same" });
  assert.deepEqual(memberUpdateEvents(member, member, GUILD_ID, null), []);
});

test("ban events carry the actor and reason", () => {
  const user = fakeMember({}).user;
  const event = memberBanEvent(user, GUILD_ID, { id: ACTOR_ID, tag: "mod#0001" }, "spam");
  assert.equal(event.type, "member.ban");
  assert.equal(event.severity, "warn");
  assert.match(field(event, "Reason"), /spam/);
});
