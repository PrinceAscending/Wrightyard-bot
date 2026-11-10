import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection, type Guild } from "discord.js";
import { CHANNEL_ID, GUILD_ID } from "../testing/helpers.js";
import { quietLogger } from "../testing/helpers.js";
import type { AuditLogResolver } from "./attribution.js";
import { WebhookTracker } from "./webhooks.js";

function collection(ids: string[]) {
  return new Collection(ids.map((id) => [id, { id }]));
}

interface FakeChannelOptions {
  id?: string;
  name?: string;
  pages?: string[][];
  fails?: boolean;
}

function fakeChannel(options: FakeChannelOptions = {}) {
  let calls = 0;
  const pages = options.pages ?? [[]];
  return {
    id: options.id ?? CHANNEL_ID,
    name: options.name ?? "general",
    guild: { id: GUILD_ID },
    fetchWebhooks: async () => {
      if (options.fails) {
        throw new Error("missing access");
      }
      const page = pages[Math.min(calls, pages.length - 1)] ?? [];
      calls += 1;
      return collection(page);
    },
  };
}

function fakeGuild(channels: ReturnType<typeof fakeChannel>[]): Guild {
  return {
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
  } as unknown as Guild;
}

function resolving(): AuditLogResolver {
  return {
    resolve: async () => ({ id: "1567000000000000003", tag: "actor#0001" }),
  } as unknown as AuditLogResolver;
}

test("observes only webhooks that appear after the baseline", async () => {
  const observed: string[] = [];
  const channel = fakeChannel({ pages: [["w1"], ["w1", "w2"]] });
  const tracker = new WebhookTracker({
    resolver: resolving(),
    security: {
      observe: (action) => {
        observed.push(action.kind);
      },
    },
    logger: quietLogger,
  });
  await tracker.warm(fakeGuild([channel]));
  await tracker.handle(channel);
  assert.deepEqual(observed, ["webhookCreate"]);
});

test("a missing baseline records ids without observing", async () => {
  const observed: string[] = [];
  const channel = fakeChannel({ pages: [["w1"]] });
  const tracker = new WebhookTracker({
    resolver: resolving(),
    security: {
      observe: (action) => {
        observed.push(action.kind);
      },
    },
    logger: quietLogger,
  });
  await tracker.handle(channel);
  assert.deepEqual(observed, []);
  await tracker.handle(channel);
  assert.deepEqual(observed, []);
});

test("fetch failures keep the old baseline and never throw", async () => {
  const observed: string[] = [];
  const channel = fakeChannel({ fails: true });
  const tracker = new WebhookTracker({
    resolver: resolving(),
    security: {
      observe: (action) => {
        observed.push(action.kind);
      },
    },
    logger: quietLogger,
  });
  await tracker.warm(fakeGuild([channel]));
  await tracker.handle(channel);
  assert.deepEqual(observed, []);
});

test("forget drops a deleted channel baseline", async () => {
  const channel = fakeChannel({ pages: [["w1"], ["w1", "w2"]] });
  const tracker = new WebhookTracker({
    resolver: resolving(),
    logger: quietLogger,
  });
  await tracker.warm(fakeGuild([channel]));
  tracker.forget(channel.id);
  await tracker.handle(channel);
  assert.ok(true);
});
