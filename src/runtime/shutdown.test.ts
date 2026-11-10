import assert from "node:assert/strict";
import { test } from "node:test";
import { quietLogger } from "../testing/helpers.js";
import { runShutdown } from "./shutdown.js";

test("runs every shutdown step in order even after a failure", async () => {
  const order: string[] = [];
  await runShutdown(
    [
      {
        name: "reconciler",
        run: async () => {
          order.push("reconciler");
        },
      },
      {
        name: "audit",
        run: async () => {
          order.push("audit");
          throw new Error("boom");
        },
      },
      {
        name: "client",
        run: async () => {
          order.push("client");
        },
      },
    ],
    quietLogger,
  );
  assert.deepEqual(order, ["reconciler", "audit", "client"]);
});

test("a hung step times out and the next step still runs", async () => {
  const order: string[] = [];
  await runShutdown(
    [
      {
        name: "slow",
        run: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      },
      {
        name: "next",
        run: async () => {
          order.push("next");
        },
      },
    ],
    quietLogger,
    10,
  );
  assert.deepEqual(order, ["next"]);
});
