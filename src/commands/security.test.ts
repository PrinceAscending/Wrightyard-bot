import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { BotContext } from "../types.js";
import type { Runtime } from "../runtime.js";
import {
  OWNER_ID,
  USER_ID,
  FakeAudit,
  makeConfig,
  makeMember,
  quietLogger,
} from "../testing/helpers.js";
import security from "./security.js";
import {
  buildSecuritySimulation,
  buildSecurityStatus,
} from "../views/security-status.js";

function fakeRuntime() {
  const audit = new FakeAudit();
  const raid = { active: false, activeUntil: null as Date | null, joinsInWindow: 0 };
  const calls = {
    setActive: [] as Array<{ active: boolean; reason: string }>,
    captures: 0,
  };
  const runtime = {
    security: {
      snapshot: () => ({
        enabled: true,
        mode: "quarantine",
        ruleCount: 14,
        lastAlertAt: null,
      }),
    },
    raid: {
      snapshot: () => ({ ...raid }),
      setActive: async (active: boolean, reason: string) => {
        calls.setActive.push({ active, reason });
        raid.active = active;
      },
    },
    snapshots: {
      last: () => null,
      captureNow: async () => {
        calls.captures += 1;
        return {
          guildId: "guild",
          capturedAt: new Date("2026-11-09T12:00:00Z"),
          roles: [{ id: "role" }],
          channels: [{ id: "channel" }, { id: "channel-2" }],
          version: 1,
        };
      },
    },
    audit,
    auditStore: { durable: true },
    cases: { durable: false },
  };
  return {
    runtime: runtime as unknown as Runtime,
    audit,
    calls,
  };
}

interface FakeInteractionOptions {
  readonly subcommand: string;
  readonly strings?: Readonly<Record<string, string>>;
  readonly memberId?: string;
}

interface FakeReply {
  readonly content?: string;
  readonly embeds?: Array<{ toJSON(): unknown }>;
  readonly flags?: number;
}

function fakeInteraction(options: FakeInteractionOptions) {
  const replies: FakeReply[] = [];
  const id = options.memberId ?? OWNER_ID;
  const interaction = {
    member: makeMember({ id, tag: "owner#0001" }),
    user: { id, tag: "owner#0001", username: "owner" },
    options: {
      getSubcommand: () => options.subcommand,
      getString: (name: string) => options.strings?.[name] ?? null,
    },
    reply: async (payload: FakeReply) => {
      replies.push(payload);
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    replies,
  };
}

function contextFor(runtime: Runtime): BotContext {
  return {
    config: makeConfig(),
    runtime,
    logger: quietLogger,
  } as unknown as BotContext;
}

test("security command is guild-only and administrator-gated", () => {
  const json = security.data.toJSON();
  assert.equal(json.name, "security");
  assert.equal(json.dm_permission, false);
  assert.equal(
    json.default_member_permissions,
    String(PermissionFlagsBits.Administrator),
  );
  assert.deepEqual(
    json.options?.map((option) => option.name),
    ["status", "raid", "snapshot", "simulate"],
  );
});

test("status embed lists rules, raid mode, snapshot age, and stores", () => {
  const embed = buildSecurityStatus({
    enabled: true,
    mode: "quarantine",
    ruleCount: 14,
    raidMode: false,
    snapshotAge: "2 minutes ago",
    auditStore: "mongodb",
    caseStore: "mongodb",
    lastAlert: null,
  }).toJSON();
  const values = embed.fields?.map((field) => field.value).join(" ") ?? "";
  assert.match(values, /quarantine/);
  assert.match(values, /14 rules/);
  assert.match(values, /mongodb/);
  assert.match(values, /2 minutes ago/);
});

test("status replies with the live security reading", async () => {
  const { runtime } = fakeRuntime();
  const { interaction, replies } = fakeInteraction({ subcommand: "status" });

  await security.execute(interaction, contextFor(runtime));

  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.flags, MessageFlags.Ephemeral);
  const embed = replies[0]?.embeds?.[0]?.toJSON() as {
    fields?: Array<{ value: string }>;
  };
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /quarantine/);
});

test("non-owners are refused before any service runs", async () => {
  const { runtime, calls } = fakeRuntime();
  const { interaction, replies } = fakeInteraction({
    subcommand: "raid",
    strings: { state: "on" },
    memberId: USER_ID,
  });

  await security.execute(interaction, contextFor(runtime));

  assert.equal(calls.setActive.length, 0);
  assert.match(replies[0]?.content ?? "", /owner/i);
});

test("missing runtime replies with the not-ready message", async () => {
  const { interaction, replies } = fakeInteraction({ subcommand: "status" });
  await security.execute(interaction, {
    ...contextFor(fakeRuntime().runtime),
    runtime: undefined,
  } as unknown as BotContext);
  assert.match(replies[0]?.content ?? "", /not ready/i);
});

test("raid on opens the raid window and reports it", async () => {
  const { runtime, calls } = fakeRuntime();
  const { interaction, replies } = fakeInteraction({
    subcommand: "raid",
    strings: { state: "on" },
  });

  await security.execute(interaction, contextFor(runtime));

  assert.deepEqual(calls.setActive, [{ active: true, reason: "requested by owner#0001" }]);
  const embed = replies[0]?.embeds?.[0]?.toJSON() as {
    fields?: Array<{ value: string }>;
  };
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /Active/);
});

test("snapshot captures once and reports the counts", async () => {
  const { runtime, calls } = fakeRuntime();
  const { interaction, replies } = fakeInteraction({ subcommand: "snapshot" });

  await security.execute(interaction, contextFor(runtime));

  assert.equal(calls.captures, 1);
  const embed = replies[0]?.embeds?.[0]?.toJSON() as {
    fields?: Array<{ value: string }>;
  };
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /2/);
});

test("simulate records a feed event marked simulated and never enforces", async () => {
  const { runtime, audit } = fakeRuntime();
  const { interaction, replies } = fakeInteraction({
    subcommand: "simulate",
    strings: { action: "channelDelete" },
  });

  await security.execute(interaction, contextFor(runtime));

  assert.equal(audit.events.length, 1);
  const event = audit.events[0];
  assert.equal(event?.type, "security.alert");
  assert.equal(event?.feed, true);
  const payload = event?.payload as {
    simulated?: boolean;
    decision?: { action?: string };
  };
  assert.equal(payload.simulated, true);
  assert.equal(payload.decision?.action, "quarantine");

  const embed = replies[0]?.embeds?.[0]?.toJSON() as {
    fields?: Array<{ value: string }>;
  };
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /quarantine/);
});

test("simulation view states that nothing was enforced", () => {
  const embed = buildSecuritySimulation({
    kind: "roleDelete",
    mode: "ban",
    decision: {
      action: "ban",
      kind: "roleDelete",
      rule: { kind: "roleDelete", windowSeconds: 60, alertAt: 2, quarantineAt: 3, banAt: 6 },
      count: 6,
    },
  }).toJSON();
  assert.match(embed.description ?? "", /No member was quarantined/);
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /ban/);
});
