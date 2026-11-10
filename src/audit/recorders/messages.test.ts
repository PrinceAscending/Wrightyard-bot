import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection } from "discord.js";
import { AUTHOR_ID, CHANNEL_ID, GUILD_ID } from "../../testing/helpers.js";
import {
  messageBulkDeleteEvent,
  messageCreateEvent,
  messageDeleteEvent,
  messageUpdateEvents,
  type MessageLike,
} from "./messages.js";

interface FakeMessageOptions {
  id?: string;
  content?: string;
  attachments?: [string, number][];
}

function fakeMessage(options: FakeMessageOptions = {}): MessageLike {
  const attachments = new Collection(
    (options.attachments ?? []).map(([name, size], index) => [
      String(index),
      { name, size, url: `https://cdn.example/${name}` },
    ]),
  );
  return {
    id: options.id ?? "msg-1",
    content: options.content ?? "",
    author: { id: AUTHOR_ID, tag: "author#0001" },
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    attachments,
    embeds: [],
  } as unknown as MessageLike;
}

function field(event: { fields?: { name: string; value: string }[] }, name: string): string {
  return event.fields?.find((entry) => entry.name === name)?.value ?? "";
}

test("delete includes content, author, and attachments", () => {
  const event = messageDeleteEvent(
    fakeMessage({ content: "buy logs", attachments: [["a.png", 2048]] }),
    GUILD_ID,
    true,
  );
  assert.equal(event.type, "message.delete");
  assert.equal(event.actor?.id, AUTHOR_ID);
  assert.match(field(event, "Content"), /buy logs/);
  assert.match(field(event, "Attachments"), /a\.png/);
});

test("delete redacts content when configured off", () => {
  const event = messageDeleteEvent(fakeMessage({ content: "secret" }), GUILD_ID, false);
  assert.match(field(event, "Content"), /content unavailable/i);
});

test("update returns both before and after", () => {
  const events = messageUpdateEvents(
    fakeMessage({ content: "before" }),
    fakeMessage({ content: "after" }),
    GUILD_ID,
    true,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "message.update");
  assert.match(field(events[0]!, "Before"), /before/);
  assert.match(field(events[0]!, "After"), /after/);
});

test("update ignores unchanged messages", () => {
  const events = messageUpdateEvents(
    fakeMessage({ content: "same" }),
    fakeMessage({ content: "same" }),
    GUILD_ID,
    true,
  );
  assert.deepEqual(events, []);
});

test("create is archive only", () => {
  assert.equal(messageCreateEvent(fakeMessage({ content: "hi" }), GUILD_ID, true).feed, false);
});

test("bulk delete records count and ids", () => {
  const events = messageBulkDeleteEvent(
    new Collection([
      ["1", fakeMessage({ id: "1", content: "a" })],
      ["2", fakeMessage({ id: "2", content: "b" })],
    ]),
    CHANNEL_ID,
    GUILD_ID,
  );
  assert.match(events.summary, /2 messages/);
  assert.match(field(events, "Message IDs"), /1, 2/);
});
