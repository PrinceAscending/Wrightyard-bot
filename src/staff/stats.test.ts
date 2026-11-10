import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, MOD_ID, STAFF_ID, FakeCaseStore, asCaseStore } from "../testing/helpers.js";
import type { DutyStore } from "./duty.js";
import { buildStaffStats } from "./stats.js";

function fakeDuty(minutes: number): DutyStore {
  return {
    minutesSince: async () => minutes,
  } as unknown as DutyStore;
}

test("stats aggregate action counts", async () => {
  const cases = new FakeCaseStore();
  await cases.create({
    guildId: GUILD_ID,
    action: "warn",
    targetId: "target-1",
    moderatorId: STAFF_ID,
  });
  await cases.create({
    guildId: GUILD_ID,
    action: "warn",
    targetId: "target-2",
    moderatorId: STAFF_ID,
  });
  await cases.create({
    guildId: GUILD_ID,
    action: "ban",
    targetId: "target-3",
    moderatorId: STAFF_ID,
  });
  await cases.create({
    guildId: GUILD_ID,
    action: "ban",
    targetId: "target-4",
    moderatorId: MOD_ID,
  });

  const stats = await buildStaffStats({
    moderatorId: STAFF_ID,
    cases: asCaseStore(cases),
    duty: fakeDuty(90),
    days: 30,
    guildId: GUILD_ID,
    now: new Date(),
  });

  assert.equal(stats.actions.warn, 2);
  assert.equal(stats.actions.ban, 1);
  assert.equal(stats.totalActions, 3);
  assert.equal(stats.dutyMinutes, 90);
  assert.equal(stats.activeDays, 1);
  assert.equal(stats.days, 30);
});

test("stats exclude cases outside the window", async () => {
  const cases = new FakeCaseStore();
  const created = await cases.create({
    guildId: GUILD_ID,
    action: "warn",
    targetId: "target-1",
    moderatorId: STAFF_ID,
  });
  created.createdAt.setTime(Date.now() - 40 * 86_400_000);

  const stats = await buildStaffStats({
    moderatorId: STAFF_ID,
    cases: asCaseStore(cases),
    duty: fakeDuty(0),
    days: 30,
    guildId: GUILD_ID,
    now: new Date(),
  });

  assert.equal(stats.totalActions, 0);
  assert.equal(stats.activeDays, 0);
});
