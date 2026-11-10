import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "discord.js";
import {
  CHANNEL_ID,
  GUILD_ID,
  OWNER_ID,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import type { AuditChannelMap } from "./channels.js";
import { AuditDispatcher } from "./dispatcher.js";
import { createAuditEvent, type AuditCategory } from "./types.js";

interface Sent {
  embeds: number;
  allowedMentions: unknown;
}

function fakeClient(sent: Sent[]): Client {
  const channel = {
    send: async (options: { embeds: unknown[]; allowedMentions: unknown }) => {
      sent.push({ embeds: options.embeds.length, allowedMentions: options.allowedMentions });
      return {};
    },
  };
  return {
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
  } as unknown as Client;
}

function event(index: number, category: AuditCategory = "message") {
  return createAuditEvent(
    { category, type: `${category}.test`, summary: `event ${index}` },
    GUILD_ID,
    `evt-${index}`,
    new Date("2026-11-09T00:00:00Z"),
  );
}

function channelsFor(category: AuditCategory): AuditChannelMap {
  return new Map([[category, CHANNEL_ID]]);
}

test("splits twelve events into batches of ten and two", async () => {
  const sent: Sent[] = [];
  const dispatcher = new AuditDispatcher({
    client: fakeClient(sent),
    config: makeConfig(),
    logger: quietLogger,
    resolveChannels: () => channelsFor("message"),
  });
  for (let index = 0; index < 12; index += 1) {
    dispatcher.enqueue(event(index));
  }
  await dispatcher.flush();
  assert.deepEqual(sent.map((batch) => batch.embeds), [10, 2]);
  await dispatcher.close();
});

test("skips archive-only categories and missing channels", async () => {
  const sent: Sent[] = [];
  const dispatcher = new AuditDispatcher({
    client: fakeClient(sent),
    config: makeConfig(),
    logger: quietLogger,
    resolveChannels: () => channelsFor("message"),
  });
  dispatcher.enqueue(event(1, "command"));
  dispatcher.enqueue(event(2, "lifecycle"));
  dispatcher.enqueue(event(3, "member"));
  await dispatcher.close();
  assert.deepEqual(sent, []);
});

test("security batches allow the owner ping, others parse nothing", async () => {
  const sent: Sent[] = [];
  const dispatcher = new AuditDispatcher({
    client: fakeClient(sent),
    config: makeConfig(),
    logger: quietLogger,
    resolveChannels: () => channelsFor("security"),
  });
  dispatcher.enqueue(event(1, "security"));
  await dispatcher.flush();
  assert.deepEqual(sent[0]?.allowedMentions, { users: [OWNER_ID] });

  const sent2: Sent[] = [];
  const messages = new AuditDispatcher({
    client: fakeClient(sent2),
    config: makeConfig(),
    logger: quietLogger,
    resolveChannels: () => channelsFor("message"),
  });
  messages.enqueue(event(2, "message"));
  await messages.flush();
  assert.deepEqual(sent2[0]?.allowedMentions, { parse: [] });
  await dispatcher.close();
  await messages.close();
});
