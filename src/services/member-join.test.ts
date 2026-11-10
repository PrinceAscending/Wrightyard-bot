import assert from "node:assert/strict";
import { test } from "node:test";
import { quietLogger, makeMember } from "../testing/helpers.js";
import { handleMemberJoin } from "./member-join.js";

test("contained joins skip auto-role and welcome", async () => {
  let communityCalls = 0;
  const outcome = await handleMemberJoin({
    member: makeMember(),
    raid: { observeJoin: async () => ({ contained: true }) },
    community: {
      onMemberJoin: async () => {
        communityCalls += 1;
      },
    },
    logger: quietLogger,
  });
  assert.equal(outcome, "contained");
  assert.equal(communityCalls, 0);
});

test("normal joins continue to auto-role and welcome", async () => {
  let communityCalls = 0;
  const outcome = await handleMemberJoin({
    member: makeMember(),
    raid: { observeJoin: async () => ({ contained: false }) },
    community: {
      onMemberJoin: async () => {
        communityCalls += 1;
      },
    },
    logger: quietLogger,
  });
  assert.equal(outcome, "community");
  assert.equal(communityCalls, 1);
});

test("a raid failure still runs the community path", async () => {
  let communityCalls = 0;
  const outcome = await handleMemberJoin({
    member: makeMember(),
    raid: {
      observeJoin: async () => {
        throw new Error("raid store unavailable");
      },
    },
    community: {
      onMemberJoin: async () => {
        communityCalls += 1;
      },
    },
    logger: quietLogger,
  });
  assert.equal(outcome, "community");
  assert.equal(communityCalls, 1);
});

test("a community failure is reported without throwing", async () => {
  const outcome = await handleMemberJoin({
    member: makeMember(),
    raid: { observeJoin: async () => ({ contained: false }) },
    community: {
      onMemberJoin: async () => {
        throw new Error("welcome failed");
      },
    },
    logger: quietLogger,
  });
  assert.equal(outcome, "failed");
});
