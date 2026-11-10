import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, Guild, GuildMember } from "discord.js";
import {
  FakeAudit,
  FakeCaseStore,
  GUILD_ID,
  MOD_ID,
  OWNER_ID,
  STEWARD_ID,
  TARGET_ID,
  USER_ID,
  asAuditService,
  asCaseStore,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import {
  StaffActions,
  StaffGuardError,
  parseDuration,
  type StaffActionsOptions,
} from "./actions.js";
import { buildCaseEmbed, buildWarningsEmbed } from "../views/staff.js";

interface MemberOptions {
  id?: string;
  roles?: string[];
  position?: number;
  bot?: boolean;
}

interface MemberSpy {
  readonly member: GuildMember;
  readonly dms: string[];
  readonly timeouts: Array<number | null>;
  readonly kicks: string[];
  readonly bans: Array<{ reason?: string; deleteMessageSeconds?: number }>;
}

function makeSpyMember(guild: Guild, options: MemberOptions = {}): MemberSpy {
  const id = options.id ?? TARGET_ID;
  const dms: string[] = [];
  const timeouts: Array<number | null> = [];
  const kicks: string[] = [];
  const bans: Array<{ reason?: string; deleteMessageSeconds?: number }> = [];
  const tag = id === TARGET_ID ? "target#0001" : "staff#0001";
  const member = {
    id,
    guild,
    user: { id, tag, username: tag.split("#")[0], bot: options.bot ?? false },
    roles: {
      cache: new Map((options.roles ?? []).map((roleId) => [roleId, { id: roleId }])),
      highest: { position: options.position ?? 1 },
    },
    send: async (payload: { content: string }) => {
      dms.push(payload.content);
    },
    timeout: async (duration: number | null) => {
      timeouts.push(duration);
    },
    kick: async (reason?: string) => {
      kicks.push(reason ?? "");
    },
    ban: async (payload: { reason?: string; deleteMessageSeconds?: number }) => {
      bans.push(payload);
    },
  } as unknown as GuildMember;
  return { member, dms, timeouts, kicks, bans };
}

interface GuildSpy {
  readonly guild: Guild;
  readonly unbans: Array<{ userId: string; reason?: string }>;
}

function makeGuild(): GuildSpy {
  const unbans: Array<{ userId: string; reason?: string }> = [];
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: {
      me: {
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
    bans: {
      remove: async (userId: string, reason?: string) => {
        unbans.push({ userId, reason });
      },
    },
  } as unknown as Guild;
  return { guild, unbans };
}

function makeActions(cases = new FakeCaseStore(), audit = new FakeAudit()) {
  const guildSpy = makeGuild();
  const config = makeConfig({
    staffModeratorRoleIds: [MOD_ID],
    staffStewardRoleIds: [STEWARD_ID],
  });
  const actions = new StaffActions({
    client: fakeClient([guildSpy.guild]) as unknown as Client,
    config,
    cases: asCaseStore(cases),
    audit: asAuditService(audit),
    logger: quietLogger,
  } satisfies StaffActionsOptions);
  return { actions, cases, audit, guild: guildSpy.guild, guildSpy };
}

function makeStaff(guild: Guild): GuildMember {
  return makeSpyMember(guild, {
    id: USER_ID,
    roles: [MOD_ID, STEWARD_ID],
    position: 50,
  }).member;
}

test("parses durations and rejects invalid values", () => {
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("7d"), 604_800_000);
  assert.equal(parseDuration("0m"), null);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("30d"), null);
});

test("warn creates an open case and records an audit event", async () => {
  const { actions, cases, audit, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  const record = await actions.warn(moderator, target.member, "spam");
  assert.equal(record.action, "warn");
  assert.equal(record.status, "open");
  assert.equal(audit.events[0]?.type, "moderation.action");
  assert.equal(target.dms.length, 1);
  assert.equal(cases.records.length, 1);
});

test("timeout calls Discord and sets the expiry", async () => {
  const { actions, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  const record = await actions.timeout(moderator, target.member, 600_000, "cool off");
  assert.equal(target.timeouts.length, 1);
  assert.equal(target.timeouts[0], 600_000);
  assert.equal(record.action, "timeout");
  assert.ok(record.expiresAt instanceof Date);
});

test("clearWarnings revokes every open warning", async () => {
  const { actions, cases, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  await actions.warn(moderator, target.member, "first");
  await actions.clearWarnings(moderator, target.member, "appealed");
  const revoked = cases.records.filter(
    (entry) => entry.action === "warn" && entry.status === "revoked",
  );
  assert.equal(revoked.length, 1);
  assert.equal(cases.records.at(-1)?.action, "warnClear");
});

test("ban clamps delete seconds and creates an open case", async () => {
  const { actions, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  const record = await actions.ban(moderator, target.member, "raid", 999_999, false);
  assert.equal(target.bans[0]?.deleteMessageSeconds, 604_800);
  assert.equal(record.action, "ban");
  assert.equal(record.status, "open");
});

test("unban removes the ban, skips hierarchy, and revokes the open case", async () => {
  const { actions, cases, guild, guildSpy } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  await actions.ban(moderator, target.member, "raid", 0, false);
  const record = await actions.unban(moderator, TARGET_ID, "appealed");
  assert.equal(record.action, "unban");
  assert.equal(cases.records.filter((entry) => entry.action === "ban" && entry.status === "revoked").length, 1);
  assert.equal(guildSpy.unbans[0]?.userId, TARGET_ID);
});

test("a moderator cannot ban a steward", async () => {
  const { actions, cases, guild } = makeActions();
  const actor = makeSpyMember(guild, {
    id: USER_ID,
    roles: [MOD_ID],
    position: 50,
  }).member;
  const target = makeSpyMember(guild, {
    id: TARGET_ID,
    roles: [STEWARD_ID],
    position: 60,
  }).member;
  await assert.rejects(() => actions.ban(actor, target, "no", 0, false), StaffGuardError);
  assert.equal(cases.records.length, 0);
});

test("a Discord failure records moderation.failed and creates no case", async () => {
  const { actions, cases, audit, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  (target.member as unknown as { timeout: () => Promise<void> }).timeout = async () => {
    throw new Error("missing permissions");
  };
  await assert.rejects(
    () => actions.timeout(moderator, target.member, 60_000, "cool off"),
    /missing permissions/,
  );
  assert.equal(cases.records.length, 0);
  assert.equal(audit.events.at(-1)?.type, "moderation.failed");
});

test("case and warning embeds render the ledger", async () => {
  const { actions, guild } = makeActions();
  const moderator = makeStaff(guild);
  const target = makeSpyMember(guild);
  const record = await actions.warn(moderator, target.member, "spam");
  const embed = buildCaseEmbed(record).toJSON();
  assert.match(embed.title ?? "", /0001/);
  assert.equal(embed.color, 0xa77d42);
  const warnings = await actions.listWarnings(target.member);
  const list = buildWarningsEmbed({ id: TARGET_ID, tag: "target#0001" }, warnings).toJSON();
  assert.match(list.description ?? "", /0001/);
});
