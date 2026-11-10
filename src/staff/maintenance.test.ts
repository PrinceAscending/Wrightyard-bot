import assert from "node:assert/strict";
import { test } from "node:test";
import { GUILD_ID, quietLogger } from "../testing/helpers.js";
import type { CaseStore } from "./cases.js";
import type { DutyStore } from "./duty.js";
import { MaintenanceService } from "./maintenance.js";

test("initialize closes stale duty and runOnce expires cases", async () => {
  const cases = { markExpired: async () => 2 } as unknown as CaseStore;
  const duty = { closeStaleSessions: async () => 1 } as unknown as DutyStore;
  const service = new MaintenanceService({
    guildId: GUILD_ID,
    cases,
    duty,
    logger: quietLogger,
    intervalMs: 60_000,
  });
  assert.equal(await service.initialize(), 1);
  assert.deepEqual(await service.runOnce(new Date("2026-11-09T12:00:00Z")), {
    expiredCases: 2,
    staleDutySessions: 1,
  });
  service.stop();
});

test("maintenance failures are logged and never thrown", async () => {
  const cases = {
    markExpired: async () => {
      throw new Error("case store unavailable");
    },
  } as unknown as CaseStore;
  const duty = {
    closeStaleSessions: async () => {
      throw new Error("duty store unavailable");
    },
  } as unknown as DutyStore;
  const service = new MaintenanceService({
    guildId: GUILD_ID,
    cases,
    duty,
    logger: quietLogger,
    intervalMs: 1_000,
  });

  assert.equal(await service.initialize(), 0);
  assert.deepEqual(await service.runOnce(), {
    expiredCases: 0,
    staleDutySessions: 0,
  });
});

test("start and stop are idempotent", () => {
  const cases = { markExpired: async () => 0 } as unknown as CaseStore;
  const duty = { closeStaleSessions: async () => 0 } as unknown as DutyStore;
  const service = new MaintenanceService({
    guildId: GUILD_ID,
    cases,
    duty,
    logger: quietLogger,
    intervalMs: 1_000,
  });
  service.start();
  service.start();
  service.stop();
  service.stop();
});
