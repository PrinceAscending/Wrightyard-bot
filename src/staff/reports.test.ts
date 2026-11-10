import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client, Guild, GuildMember } from "discord.js";
import {
  GUILD_ID,
  MOD_ID,
  OWNER_ID,
  STAFF_ID,
  TARGET_ID,
  USER_ID,
  FakeAudit,
  FakeCaseStore,
  asAuditService,
  asCaseStore,
  fakeClient,
  makeConfig,
  quietLogger,
} from "../testing/helpers.js";
import { StaffActions } from "./actions.js";

function makeGuild(): Guild {
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: {
      me: {
        roles: { highest: { position: 100 } },
        permissions: { has: () => true },
      },
    },
  } as unknown as Guild;
}

function makeMember(guild: Guild, id: string, positions = 10): GuildMember {
  return {
    id,
    guild,
    user: { id, tag: `${id}#0001`, username: id, bot: false },
    roles: {
      cache: new Map([[MOD_ID, { id: MOD_ID }]]),
      highest: { position: positions },
    },
  } as unknown as GuildMember;
}

function makeActions() {
  const guild = makeGuild();
  const cases = new FakeCaseStore();
  const audit = new FakeAudit();
  const actions = new StaffActions({
    client: fakeClient([guild]) as unknown as Client,
    config: makeConfig({ staffModeratorRoleIds: [MOD_ID] }),
    cases: asCaseStore(cases),
    audit: asAuditService(audit),
    logger: quietLogger,
  });
  return { actions, guild, cases, audit };
}

test("note creates a closed note case", async () => {
  const { actions, guild, cases } = makeActions();
  const record = await actions.note(
    makeMember(guild, STAFF_ID, 50),
    makeMember(guild, TARGET_ID),
    "watch this account",
  );
  assert.equal(record.action, "note");
  assert.equal(record.status, "closed");
  const notes = await actions.listNotes(makeMember(guild, TARGET_ID));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.reason, "watch this account");
  assert.equal(cases.records.length, 1);
});

test("report creates an open case with reporter metadata", async () => {
  const { actions, guild, cases, audit } = makeActions();
  const reporter = makeMember(guild, USER_ID);
  const target = makeMember(guild, TARGET_ID, 0);
  const record = await actions.report(reporter, target, "harassment");
  assert.equal(record.action, "report");
  assert.equal(record.status, "open");
  assert.equal(record.moderatorId, USER_ID);
  assert.equal(record.metadata.reporterId, USER_ID);
  assert.equal(audit.events.at(-1)?.type, "moderation.report");
  assert.equal(cases.records.length, 1);
});

test("resolveCase closes an open case and writes a caseResolve record", async () => {
  const { actions, guild, cases } = makeActions();
  const moderator = makeMember(guild, STAFF_ID, 50);
  const target = makeMember(guild, TARGET_ID);
  const warning = await actions.warn(moderator, target, "spam");
  const resolved = await actions.resolveCase(moderator, warning.caseId, "appealed");
  assert.equal(resolved.action, "caseResolve");
  const closed = await cases.get(GUILD_ID, warning.caseId);
  assert.equal(closed?.status, "closed");
});

test("resolveCase rejects closed or missing cases", async () => {
  const { actions, guild } = makeActions();
  const moderator = makeMember(guild, STAFF_ID, 50);
  await assert.rejects(() => actions.resolveCase(moderator, 999), /not found/);

  const target = makeMember(guild, TARGET_ID);
  const note = await actions.note(moderator, target, "already closed");
  await assert.rejects(
    () => actions.resolveCase(moderator, note.caseId),
    /closed, not open/,
  );
});
