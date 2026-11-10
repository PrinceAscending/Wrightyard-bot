import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchQueue } from "./batch.js";
import { quietLogger } from "../testing/helpers.js";

test("flushes at max size and on close", async () => {
  const batches: number[][] = [];
  const queue = new BatchQueue<number>({
    maxSize: 3,
    flushMs: 10,
    send: async (items) => {
      batches.push([...items]);
    },
    logger: quietLogger,
  });
  queue.push(1);
  queue.push(2);
  queue.push(3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  queue.push(4);
  await queue.close();
  assert.deepEqual(batches, [[1, 2, 3], [4]]);
});

test("never sends an empty batch and ignores pushes after close", async () => {
  let sends = 0;
  const queue = new BatchQueue<number>({
    maxSize: 2,
    flushMs: 5,
    send: async () => {
      sends += 1;
    },
    logger: quietLogger,
  });
  await queue.flush();
  await queue.close();
  queue.push(1);
  await queue.flush();
  assert.equal(sends, 0);
});

test("a failed send does not block later batches", async () => {
  const batches: number[][] = [];
  const queue = new BatchQueue<number>({
    maxSize: 2,
    flushMs: 5,
    send: async (items) => {
      batches.push([...items]);
      if (items.includes(1)) {
        throw new Error("boom");
      }
    },
    logger: quietLogger,
  });
  queue.push(1);
  queue.push(2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.push(3);
  queue.push(4);
  await queue.close();
  assert.deepEqual(batches, [[1, 2], [3, 4]]);
});
