import assert from "node:assert/strict";
import { test } from "node:test";
import type { MongoClient } from "mongodb";
import { BotDatabase } from "./db.js";
import { quietLogger } from "./testing/helpers.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClient(connecting: Promise<void>): MongoClient {
  return {
    connect: () => connecting,
    close: async () => undefined,
    db: (dbName: string) => ({
      collection: (name: string) => ({ database: dbName, name }),
    }),
  } as unknown as MongoClient;
}

test("unconfigured database rejects collection access", async () => {
  const db = new BotDatabase({ uri: null, dbName: "wrightyard", logger: quietLogger });
  assert.equal(db.configured, false);
  await assert.rejects(() => db.collection("audit_events"), /MongoDB is not configured/);
});

test("closing an unconfigured database is a no-op", async () => {
  const db = new BotDatabase({ uri: null, dbName: "wrightyard", logger: quietLogger });
  await db.close();
  assert.equal(db.configured, false);
});

test("close during connect rejects instead of returning a torn-down client", async () => {
  const connecting = deferred<void>();
  const db = new BotDatabase({
    uri: "mongodb://localhost:27017",
    dbName: "wrightyard",
    logger: quietLogger,
    clientFactory: () => fakeClient(connecting.promise),
  });

  const pending = db.collection("audit_events");
  await db.close();
  connecting.resolve();

  await assert.rejects(pending, /closed during connect/);
});

test("a stale connect failure does not clobber a newer client", async () => {
  const firstConnect = deferred<void>();
  const secondConnect = deferred<void>();
  const clients = [fakeClient(firstConnect.promise), fakeClient(secondConnect.promise)];
  let created = 0;

  const db = new BotDatabase({
    uri: "mongodb://localhost:27017",
    dbName: "wrightyard",
    logger: quietLogger,
    clientFactory: () => {
      const client = clients[created];
      created += 1;
      if (!client) {
        throw new Error("unexpected third client");
      }
      return client;
    },
  });

  const firstCall = db.collection("audit_events");
  await db.close();

  const secondCall = db.collection("audit_events");
  secondConnect.resolve();
  await secondCall;

  firstConnect.reject(new Error("topology was destroyed"));
  await assert.rejects(firstCall, /topology was destroyed/);

  const collection = await db.collection("audit_events");

  assert.equal(created, 2);
  assert.equal((collection as unknown as { name: string }).name, "audit_events");
});
