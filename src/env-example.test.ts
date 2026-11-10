import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("documents every new logging, staff, and security variable", () => {
  const text = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  for (const key of [
    "LOG_CATEGORY_ID",
    "LOG_CHANNEL_ID",
    "MESSAGE_LOG_CHANNEL_ID",
    "MEMBER_LOG_CHANNEL_ID",
    "SERVER_LOG_CHANNEL_ID",
    "VOICE_LOG_CHANNEL_ID",
    "SECURITY_LOG_CHANNEL_ID",
    "MOD_LOG_CHANNEL_ID",
    "LOG_MESSAGE_CONTENT",
    "AUDIT_RETENTION_DAYS",
    "STAFF_MODERATOR_ROLE_IDS",
    "STAFF_STEWARD_ROLE_IDS",
    "STAFF_ADMIN_ROLE_IDS",
    "STAFF_FOUNDER_ROLE_IDS",
    "ANTINUKE_ENABLED",
    "ANTINUKE_MODE",
    "ANTINUKE_TRUSTED_USER_IDS",
    "ANTINUKE_QUARANTINE_ROLE_ID",
    "ANTINUKE_RESTORE",
    "RAID_GUARD_ENABLED",
    "RAID_JOIN_THRESHOLD",
    "RAID_WINDOW_SECONDS",
    "RAID_MIN_ACCOUNT_AGE_DAYS",
    "RAID_MODE_MINUTES",
    "SNAPSHOT_INTERVAL_MINUTES",
  ]) {
    assert.match(text, new RegExp(`^${key}=`, "m"), key);
  }
});
