import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  DISCORD_TOKEN: "test-token",
  DISCORD_CLIENT_ID: "1566784935342252032",
  DISCORD_GUILD_ID: "1566778873985892442",
  OWNER_ID: "971329961313046578",
};

test("applies security and logging defaults", () => {
  const { config } = loadConfig({ ...BASE_ENV });
  assert.equal(config.antiNukeEnabled, true);
  assert.equal(config.antiNukeMode, "quarantine");
  assert.equal(config.antiNukeRestore, true);
  assert.equal(config.raidGuardEnabled, true);
  assert.equal(config.raidJoinThreshold, 8);
  assert.equal(config.raidWindowSeconds, 60);
  assert.equal(config.raidMinAccountAgeDays, 7);
  assert.equal(config.raidModeMinutes, 10);
  assert.equal(config.snapshotIntervalMinutes, 360);
  assert.equal(config.logMessageContent, true);
  assert.equal(config.auditRetentionDays, 0);
});

test("rejects an unknown anti-nuke mode", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, ANTINUKE_MODE: "bogus" }),
    /ANTINUKE_MODE must be alert, quarantine, or ban/,
  );
});

test("merges staff tiers into staffRoleIds", () => {
  const { config } = loadConfig({
    ...BASE_ENV,
    STAFF_ROLE_IDS: "111111111111111111",
    STAFF_STEWARD_ROLE_IDS: "222222222222222222",
  });
  assert.deepEqual([...config.staffRoleIds].sort(), [
    "111111111111111111",
    "222222222222222222",
  ]);
  assert.deepEqual(config.staffStewardRoleIds, ["222222222222222222"]);
});

test("warns only when every staff source is empty", () => {
  const empty = loadConfig({ ...BASE_ENV });
  const tierOnly = loadConfig({
    ...BASE_ENV,
    STAFF_STEWARD_ROLE_IDS: "222222222222222222",
  });
  const staffWarning = (warnings: readonly string[]): boolean =>
    warnings.some((warning) => warning.includes("every staff tier are empty"));

  assert.equal(staffWarning(empty.warnings), true);
  assert.equal(staffWarning(tierOnly.warnings), false);
});

test("parses log routing, content, retention, and trust", () => {
  const { config } = loadConfig({
    ...BASE_ENV,
    LOG_CHANNEL_ID: "333333333333333333",
    LOG_MESSAGE_CONTENT: "false",
    AUDIT_RETENTION_DAYS: "30",
    ANTINUKE_TRUSTED_USER_IDS: "444444444444444444",
  });
  assert.equal(config.logChannelId, "333333333333333333");
  assert.equal(config.logMessageContent, false);
  assert.equal(config.auditRetentionDays, 30);
  assert.deepEqual(config.antiNukeTrustedUserIds, ["444444444444444444"]);
});
