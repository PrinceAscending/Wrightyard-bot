import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits } from "discord.js";
import report from "./report.js";
import staff, { STAFF_SUBCOMMAND_RANK, parseCaseId } from "./staff.js";

test("staff subcommand rank map matches the spec", () => {
  assert.equal(STAFF_SUBCOMMAND_RANK.warn, "moderator");
  assert.equal(STAFF_SUBCOMMAND_RANK.ban, "steward");
  assert.equal(STAFF_SUBCOMMAND_RANK.clearwarnings, "steward");
  assert.equal(STAFF_SUBCOMMAND_RANK.duty, "moderator");
});

test("staff command serializes with every subcommand", () => {
  const json = staff.data.toJSON();
  assert.equal(json.name, "staff");
  assert.equal(json.options?.length, 18);
  assert.deepEqual(
    json.options?.map((option) => option.name),
    Object.keys(STAFF_SUBCOMMAND_RANK),
  );
  assert.equal(json.dm_permission, false);
  assert.equal(
    json.default_member_permissions,
    String(PermissionFlagsBits.ManageMessages),
  );
});

test("report is public and guild-only", () => {
  const json = report.data.toJSON();
  assert.equal(json.name, "report");
  assert.equal(json.dm_permission, false);
  assert.equal(json.default_member_permissions, undefined);
});

test("parseCaseId accepts #0001 and 1", () => {
  assert.equal(parseCaseId("#0001"), 1);
  assert.equal(parseCaseId("42"), 42);
  assert.throws(() => parseCaseId("#00x1"));
  assert.throws(() => parseCaseId("0"));
});
