import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Collection,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import type { AntiNukeMode } from "../config.js";
import type { IncidentRestorer, ObservedAction, SecurityStatePort } from "./types.js";
import {
  ACTOR_ID,
  BOT_ID,
  GUILD_ID,
  OWNER_ID,
  QUARANTINE_ID,
  ROLE_ID,
  TRUSTED_ID,
  FakeAudit,
  FakeCaseStore,
  asAuditService,
  asCaseStore,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import { SecurityService } from "./service.js";
import { buildSecurityAlert } from "../views/security.js";

const NOW = new Date("2026-11-09T00:00:00Z");

interface FakeMember {
  readonly member: GuildMember;
  readonly rolesSet: string[][];
  readonly timeouts: number[];
}

function makeFakeMember(
  guild: Guild,
  id: string,
  position = 10,
  initialRoles: readonly string[] = [ROLE_ID],
): FakeMember {
  const rolesSet: string[][] = [];
  const timeouts: number[] = [];
  const cache = new Collection<string, Role>(
    initialRoles.map((roleId) => [
      roleId,
      { id: roleId, name: roleId === QUARANTINE_ID ? "Quarantined" : "member" } as Role,
    ]),
  );
  const member = {
    id,
    guild,
    user: { id, tag: `${id}#0001`, username: id, bot: false },
    roles: {
      cache,
      highest: { position },
      set: async (ids: readonly string[]) => {
        rolesSet.push([...ids]);
        cache.clear();
        for (const roleId of ids) {
          cache.set(
            roleId,
            {
              id: roleId,
              name: roleId === QUARANTINE_ID ? "Quarantined" : "member",
            } as Role,
          );
        }
      },
    },
    timeout: async (durationMs: number) => {
      timeouts.push(durationMs);
    },
  } as unknown as GuildMember;
  return { member, rolesSet, timeouts };
}

interface FakeGuild {
  readonly guild: Guild;
  readonly bans: string[];
  readonly rolesCreated: string[];
  readonly member: FakeMember;
  setPosition(position: number): void;
  setMissing(missing: boolean): void;
}

function makeFakeGuild(): FakeGuild {
  const bans: string[] = [];
  const rolesCreated: string[] = [];
  const roles = new Collection<string, Role>([
    [
      QUARANTINE_ID,
      { id: QUARANTINE_ID, name: "Quarantined" } as Role,
    ],
  ]);
  let membership: FakeMember;
  let missing = false;

  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: {
      me: {
        roles: { highest: { position: 100 } },
        permissions: {
          has: (permission: bigint) => permission === PermissionFlagsBits.ModerateMembers,
        },
      },
      cache: new Collection(),
      fetch: async () => {
        if (missing) {
          throw new Error("Unknown Member");
        }
        return membership.member;
      },
      ban: async (id: string) => {
        bans.push(id);
      },
    },
    roles: {
      cache: roles,
      fetch: async () => null,
      create: async (options: { name: string }) => {
        rolesCreated.push(options.name);
        return { id: QUARANTINE_ID, name: options.name } as Role;
      },
    },
  } as unknown as Guild;

  membership = makeFakeMember(guild, ACTOR_ID, 10);
  (guild.members.cache as Collection<string, GuildMember>).set(
    ACTOR_ID,
    membership.member,
  );

  return {
    guild,
    bans,
    rolesCreated,
    get member() {
      return membership;
    },
    setPosition(position: number) {
      (membership.member.roles.highest as { position: number }).position = position;
    },
    setMissing(value: boolean) {
      missing = value;
      (guild.members.cache as Collection<string, GuildMember>).clear();
    },
  };
}

interface FakeRestore extends IncidentRestorer {
  readonly calls: Array<{ actions: readonly ObservedAction[]; reason: string }>;
}

function makeRestore(): FakeRestore {
  const calls: Array<{ actions: readonly ObservedAction[]; reason: string }> = [];
  return {
    calls,
    restoreIncident: async (actions, reason) => {
      calls.push({ actions, reason });
      return undefined;
    },
  };
}

interface FakeState extends SecurityStatePort {
  readonly actions: Array<{ guildId: string; actorId: string; at: Date }>;
  readonly alerts: Date[];
}

function makeState(): FakeState {
  const actions: Array<{ guildId: string; actorId: string; at: Date }> = [];
  const alerts: Date[] = [];
  return {
    actions,
    alerts,
    get: async () => ({ raidMode: false, raidUntil: null }),
    setRaidMode: async () => undefined,
    markAction: async (guildId, actorId, at) => {
      actions.push({ guildId, actorId, at });
    },
    markAlert: async (_guildId, at) => {
      alerts.push(at);
    },
  };
}

interface ServiceOptions {
  mode?: AntiNukeMode;
  trusted?: readonly string[];
  quarantineRoleId?: string | null;
  restore?: FakeRestore;
  state?: FakeState;
  guild?: FakeGuild;
  now?: Date;
}

function makeService(options: ServiceOptions = {}) {
  const fakeGuild = options.guild ?? makeFakeGuild();
  const cases = new FakeCaseStore();
  const audit = new FakeAudit();
  const restore = options.restore ?? makeRestore();
  const service = new SecurityService({
    client: fakeClient([fakeGuild.guild]) as unknown as Client,
    config: makeConfig({
      antiNukeMode: options.mode ?? "quarantine",
      antiNukeTrustedUserIds: [...(options.trusted ?? [])],
      antiNukeQuarantineRoleId:
        options.quarantineRoleId === undefined
          ? QUARANTINE_ID
          : options.quarantineRoleId,
    }),
    cases: asCaseStore(cases),
    audit: asAuditService(audit),
    restore,
    ...(options.state ? { state: options.state } : {}),
    logger: quietLogger,
    now: () => options.now ?? NOW,
  });
  return { service, fakeGuild, cases, audit, restore, state: options.state };
}

function makeAction(
  kind: ObservedAction["kind"],
  at: Date = NOW,
  overrides: Partial<ObservedAction> = {},
): ObservedAction {
  return {
    kind,
    guildId: GUILD_ID,
    actorId: ACTOR_ID,
    actorTag: "actor#0001",
    targetId: "target",
    targetName: "target",
    at,
    ...overrides,
  };
}

test("owner, bot, and trusted users are never punished or alerted", async () => {
  const { service, fakeGuild, audit } = makeService({ trusted: [TRUSTED_ID] });
  for (const actorId of [OWNER_ID, BOT_ID, TRUSTED_ID]) {
    for (let index = 0; index < 3; index += 1) {
      service.observe(makeAction("channelDelete", NOW, { actorId }));
    }
  }
  await service.flush();
  assert.equal(fakeGuild.member.rolesSet.length, 0);
  assert.equal(audit.events.filter((event) => event.type === "security.alert").length, 0);
});

test("quarantine removes roles and adds the quarantine role", async () => {
  const { service, fakeGuild, audit, cases, restore, state } = makeService({
    state: makeState(),
  });
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.deepEqual(fakeGuild.member.rolesSet, [[QUARANTINE_ID]]);
  assert.deepEqual(fakeGuild.member.timeouts, [86_400_000]);
  assert.ok(audit.events.some((event) => event.type === "security.quarantine"));
  assert.ok(cases.records.some((record) => record.action === "quarantine"));
  assert.equal(restore.calls.length, 1);
  assert.equal(state?.actions.length, 1);
  assert.ok((state?.alerts.length ?? 0) >= 1);
});

test("ban mode bans at the ban threshold", async () => {
  const { service, fakeGuild } = makeService({ mode: "ban" });
  for (let index = 0; index < 6; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.deepEqual(fakeGuild.bans, [ACTOR_ID]);
  assert.equal(fakeGuild.member.rolesSet.length, 0);
});

test("an actioned actor is ignored for 300 seconds", async () => {
  const { service, fakeGuild } = makeService();
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.equal(fakeGuild.member.rolesSet.length, 1);
});

test("alert mode records an alert without enforcing", async () => {
  const { service, fakeGuild, audit } = makeService({ mode: "alert" });
  for (let index = 0; index < 10; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.equal(fakeGuild.member.rolesSet.length, 0);
  assert.deepEqual(fakeGuild.bans, []);
  const alert = audit.events.find((event) => event.type === "security.alert");
  assert.ok(alert);
  assert.equal((alert.payload as { action: string }).action, "alert");
});

test("an actor at or above the bot is blocked with a critical alert", async () => {
  const { service, fakeGuild, audit } = makeService();
  fakeGuild.setPosition(100);
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.equal(fakeGuild.member.rolesSet.length, 0);
  const alert = audit.events.find((event) => event.type === "security.alert");
  assert.equal(alert?.severity, "critical");
  assert.equal((alert?.payload as { blocked?: boolean }).blocked, true);
});

test("a departed actor gets an alert but no case", async () => {
  const { service, fakeGuild, audit, cases } = makeService();
  fakeGuild.setMissing(true);
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.equal(cases.records.length, 0);
  const alert = audit.events.find((event) => event.type === "security.alert");
  assert.equal(alert?.severity, "critical");
});

test("the alert view mentions the owner and carries the rule", () => {
  const embed = buildSecurityAlert({
    ownerId: OWNER_ID,
    heading: "Anti-nuke alert: actor · channelDelete",
    rule: "channelDelete",
    count: 3,
    windowSeconds: 60,
    actorId: ACTOR_ID,
    actorTag: "actor#0001",
    action: "quarantine",
    caseId: 7,
    guildId: GUILD_ID,
    channelId: null,
  }).toJSON();
  assert.match(embed.description ?? "", new RegExp(`<@${OWNER_ID}>`));
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /channelDelete/);
  assert.match(embed.fields?.map((field) => field.value).join(" ") ?? "", /#0007/);
});

test("snapshot reports the mode and last alert", async () => {
  const { service } = makeService();
  const before = service.snapshot();
  assert.equal(before.enabled, true);
  assert.equal(before.mode, "quarantine");
  assert.equal(before.ruleCount, 14);
  for (let index = 0; index < 3; index += 1) {
    service.observe(makeAction("channelDelete", NOW, { actorId: ACTOR_ID }));
  }
  await service.flush();
  assert.ok(service.snapshot().lastAlertAt instanceof Date);
});
