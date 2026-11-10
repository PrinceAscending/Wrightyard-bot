import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_ID,
  MOD_ID,
  OWNER_ID,
  STEWARD_ID,
  makeConfig,
  makeMember,
} from "../testing/helpers.js";
import { atLeast, resolveStaffRank } from "./ranks.js";

test("owner is always founder", () => {
  assert.equal(
    resolveStaffRank(makeMember({ id: OWNER_ID }), makeConfig(), OWNER_ID),
    "founder",
  );
});

test("highest configured tier wins", () => {
  const config = makeConfig({
    staffModeratorRoleIds: [MOD_ID],
    staffStewardRoleIds: [STEWARD_ID],
    staffAdminRoleIds: [ADMIN_ID],
  });
  assert.equal(
    resolveStaffRank(makeMember({ roles: [MOD_ID, STEWARD_ID] }), config),
    "steward",
  );
  assert.equal(
    resolveStaffRank(makeMember({ roles: [STEWARD_ID, ADMIN_ID] }), config),
    "admin",
  );
});

test("falls back to moderator when no tiers are configured", () => {
  const config = makeConfig({ staffRoleIds: [MOD_ID] });
  assert.equal(resolveStaffRank(makeMember({ roles: [MOD_ID] }), config), "moderator");
});

test("rank comparison is ordered", () => {
  assert.equal(atLeast("admin", "steward"), true);
  assert.equal(atLeast("moderator", "steward"), false);
});
