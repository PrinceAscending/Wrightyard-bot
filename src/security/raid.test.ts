import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuildMember } from "discord.js";
import type { AuditEventInput } from "../audit/types.js";
import { GUILD_ID, FakeAudit, asAuditService, makeConfig, makeMember, quietLogger } from "../testing/helpers.js";
import type { ModerationCase } from "../staff/cases.js";
import type { SecurityStatePort } from "./types.js";
import { RaidGuard, type RaidGuardOptions } from "./raid.js";

const NOW = new Date("2026-11-09T00:00:00Z");
const DAY_MS = 86_400_000;

class FakeState implements SecurityStatePort {
  public raidMode: boolean;
  public raidUntil: Date | null;
  public readonly calls: Array<Date | null> = [];

  public constructor(initial: { raidMode?: boolean; raidUntil?: Date | null } = {}) {
    this.raidMode = initial.raidMode ?? false;
    this.raidUntil = initial.raidUntil ?? null;
  }

  public async get(): Promise<{ raidMode: boolean; raidUntil: Date | null }> {
    return { raidMode: this.raidMode, raidUntil: this.raidUntil };
  }

  public async setRaidMode(_guildId: string, until: Date | null): Promise<void> {
    this.calls.push(until);
    this.raidMode = until !== null;
    this.raidUntil = until;
  }

  public async markAction(): Promise<void> {
    return undefined;
  }

  public async markAlert(): Promise<void> {
    return undefined;
  }
}

interface FakeSecurity {
  readonly quarantined: string[];
  result: ModerationCase | null;
  quarantineMember(
    member: GuildMember,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<ModerationCase | null>;
}

function fakeSecurity(): FakeSecurity {
  const security: FakeSecurity = {
    quarantined: [],
    result: { caseId: 1 } as ModerationCase,
    async quarantineMember(member) {
      security.quarantined.push(member.id);
      return security.result;
    },
  };
  return security;
}

function accountCreated(daysAgo: number): Date {
  return new Date(NOW.getTime() - daysAgo * DAY_MS);
}

function makeGuard(
  options: {
    active?: boolean;
    state?: FakeState;
    now?: () => Date;
    security?: FakeSecurity;
    config?: Partial<ReturnType<typeof makeConfig>>;
  } = {},
): { guard: RaidGuard; audit: FakeAudit; security: FakeSecurity; state: FakeState } {
  const audit = new FakeAudit();
  const security = options.security ?? fakeSecurity();
  const state = options.state ?? new FakeState();
  const guardOptions: RaidGuardOptions = {
    config: makeConfig(options.config),
    security,
    audit: asAuditService(audit),
    logger: quietLogger,
    state,
    now: options.now ?? (() => NOW),
  };
  return { guard: new RaidGuard(guardOptions), audit, security, state };
}

function raidEvents(audit: FakeAudit): AuditEventInput[] {
  return audit.events.filter((event) => event.type === "security.raid");
}

test("a join flood activates raid mode", async () => {
  const { guard, audit, security } = makeGuard();
  for (let index = 0; index < 8; index += 1) {
    await guard.observeJoin(makeMember({ createdAt: accountCreated(100) }));
  }
  assert.equal(guard.active, true);
  assert.ok(audit.events.some((event) => event.type === "security.raid"));
  assert.equal(security.quarantined.length, 1);
});

test("young accounts are kicked during raid mode", async () => {
  const { guard } = makeGuard();
  await guard.setActive(true, "test");
  const member = makeMember({ createdAt: accountCreated(2) });
  const result = await guard.observeJoin(member);
  assert.equal(member.kicked, true);
  assert.equal(result.contained, true);
});

test("older accounts are quarantined during raid mode", async () => {
  const security = fakeSecurity();
  const { guard } = makeGuard({ security });
  await guard.setActive(true, "test");
  const result = await guard.observeJoin(
    makeMember({ createdAt: accountCreated(100) }),
  );
  assert.equal(security.quarantined.length, 1);
  assert.equal(result.contained, true);
});

test("raid mode auto-exits after the configured minutes", async () => {
  let current = NOW;
  const { guard } = makeGuard({ now: () => current });
  await guard.setActive(true, "test");
  current = new Date(NOW.getTime() + 11 * 60_000);
  const result = await guard.observeJoin(
    makeMember({ createdAt: accountCreated(100) }),
  );
  assert.equal(guard.active, false);
  assert.equal(result.contained, false);
});

test("restoreState resumes a persisted raid window without a duplicate alert", async () => {
  const state = new FakeState({
    raidMode: true,
    raidUntil: new Date(NOW.getTime() + 10 * 60_000),
  });
  const { guard, audit } = makeGuard({
    state,
    now: () => new Date(NOW.getTime() + 5 * 60_000),
  });
  await guard.restoreState();
  assert.equal(guard.active, true);
  assert.equal(raidEvents(audit).length, 0);
});

test("restoreState clears an expired persisted raid window", async () => {
  const state = new FakeState({
    raidMode: true,
    raidUntil: new Date(NOW.getTime() - 60_000),
  });
  const { guard } = makeGuard({ state });
  await guard.restoreState();
  assert.equal(guard.active, false);
  assert.equal(state.raidMode, false);
  assert.equal(state.calls.at(-1), null);
});

test("disabled raid guard never activates or contains", async () => {
  const { guard, audit, security } = makeGuard({
    config: { raidGuardEnabled: false },
  });
  for (let index = 0; index < 20; index += 1) {
    const result = await guard.observeJoin(
      makeMember({ createdAt: accountCreated(1) }),
    );
    assert.equal(result.contained, false);
  }
  assert.equal(guard.active, false);
  assert.equal(security.quarantined.length, 0);
  assert.equal(raidEvents(audit).length, 0);
});

test("bot joins are ignored for both the flood count and containment", async () => {
  const { guard, security } = makeGuard();
  for (let index = 0; index < 20; index += 1) {
    const result = await guard.observeJoin(
      makeMember({ bot: true, createdAt: accountCreated(1) }),
    );
    assert.equal(result.contained, false);
  }
  assert.equal(guard.active, false);
  assert.equal(security.quarantined.length, 0);
  assert.equal(guard.snapshot().joinsInWindow, 0);
});

test("setActive persists the deadline and clearing persists null", async () => {
  const state = new FakeState();
  const { guard } = makeGuard({ state });
  await guard.setActive(true, "requested");
  assert.ok(state.raidUntil);
  await guard.setActive(false, "requested");
  assert.equal(state.calls.at(-1), null);
  assert.equal(state.raidMode, false);
});

test("a failed containment returns false so the welcome path can run", async () => {
  const security = fakeSecurity();
  security.result = null;
  const { guard } = makeGuard({ security });
  await guard.setActive(true, "test");
  const result = await guard.observeJoin(
    makeMember({ createdAt: accountCreated(100) }),
  );
  assert.equal(result.contained, false);
});

test("snapshot prunes old joins and expires the active window", async () => {
  let current = NOW;
  const { guard } = makeGuard({ now: () => current });
  await guard.setActive(true, "test");
  current = new Date(NOW.getTime() + 11 * 60_000);
  const snapshot = guard.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.activeUntil, null);
  assert.equal(snapshot.joinsInWindow, 0);
});
