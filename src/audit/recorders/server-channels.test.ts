import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORY_ID, GUILD_ID, ROLE_ID } from "../../testing/helpers.js";
import {
  channelCreateEvent,
  channelDeleteEvent,
  channelUpdateEvents,
  threadUpdateEvents,
  type ChannelLike,
  type OverwriteLike,
  type ThreadLike,
} from "./server-channels.js";

interface FakeChannelOptions {
  name?: string;
  type?: number;
  parentId?: string | null;
  topic?: string | null;
  position?: number;
  overwrites?: OverwriteLike[];
}

function fakeChannel(options: FakeChannelOptions = {}): ChannelLike {
  const overwrites = new Map(
    (options.overwrites ?? []).map((overwrite) => [overwrite.id, overwrite]),
  );
  return {
    id: "1567000000000000200",
    name: options.name ?? "general",
    type: options.type ?? 0,
    parentId: options.parentId === undefined ? CATEGORY_ID : options.parentId,
    position: options.position ?? 1,
    topic: options.topic === undefined ? null : options.topic,
    nsfw: false,
    rateLimitPerUser: 0,
    bitrate: 0,
    userLimit: 0,
    permissionOverwrites: { cache: overwrites as unknown as Map<string, OverwriteLike> },
  };
}

function fakeThread(options: { name?: string; archived?: boolean; locked?: boolean } = {}): ThreadLike {
  return {
    ...fakeChannel({ name: options.name ?? "thread" }),
    archived: options.archived ?? false,
    locked: options.locked ?? false,
  };
}

function field(event: { fields?: { name: string; value: string }[] }, name: string): string {
  return event.fields?.find((entry) => entry.name === name)?.value ?? "";
}

test("channel create records type, parent, and position", () => {
  const event = channelCreateEvent(
    fakeChannel({ name: "general", type: 0, parentId: CATEGORY_ID }),
    GUILD_ID,
    null,
  );
  assert.equal(event.type, "channel.create");
  assert.match(event.summary, /general/);
  assert.match(field(event, "Parent"), new RegExp(CATEGORY_ID));
});

test("channel update separates properties from overwrites", () => {
  const events = channelUpdateEvents(
    fakeChannel({
      name: "old",
      topic: "a",
      overwrites: [{ id: ROLE_ID, allow: 0n, deny: 1024n }],
    }),
    fakeChannel({
      name: "new",
      topic: "b",
      overwrites: [{ id: ROLE_ID, allow: 2048n, deny: 0n }],
    }),
    GUILD_ID,
    null,
  );
  assert.ok(events.some((event) => event.type === "channel.update"));
  assert.ok(events.some((event) => event.type === "channel.overwrites"));
});

test("channel update returns nothing when unchanged", () => {
  assert.deepEqual(channelUpdateEvents(fakeChannel(), fakeChannel(), GUILD_ID, null), []);
});

test("thread update records archive and lock changes", () => {
  const events = threadUpdateEvents(
    fakeThread({ name: "thread", archived: false, locked: false }),
    fakeThread({ name: "thread", archived: true, locked: true }),
    GUILD_ID,
    null,
  );
  assert.equal(events[0]?.type, "thread.update");
});

test("channel delete payload can rebuild the channel", () => {
  const event = channelDeleteEvent(fakeChannel(), GUILD_ID, null);
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.name, "general");
  assert.equal(payload.parentId, CATEGORY_ID);
  assert.ok(Array.isArray(payload.overwrites));
});
