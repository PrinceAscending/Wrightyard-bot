import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { startHealthServer, stopHealthServer } from "../dist/services/health.js";
import { HeartbeatService } from "../dist/services/heartbeat.js";
import { PresenceService } from "../dist/services/presence.js";
import { BotState } from "../dist/state.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loggerStub() {
  const noop = () => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => loggerStub(),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  return address.port;
}

async function testHealth() {
  const logger = loggerStub();
  const state = new BotState();
  const client = {
    isReady: () => false,
    guilds: { cache: new Map() },
  };

  const server = await startHealthServer({
    port: 0,
    client,
    state,
    version: "9.9.9-test",
    logger,
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const booting = await fetch(`${base}/health`);
    assert.equal(booting.status, 503);
    const bootingBody = await booting.json();
    assert.deepEqual(Object.keys(bootingBody).sort(), [
      "guilds",
      "ok",
      "ready",
      "uptimeSeconds",
      "version",
    ]);
    assert.equal(bootingBody.ok, false);
    assert.equal(bootingBody.ready, false);
    assert.equal(bootingBody.version, "9.9.9-test");

    client.isReady = () => true;
    const ready = await fetch(`${base}/`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.ready, true);
    assert.equal(readyBody.guilds, 0);
    assert.equal(typeof readyBody.uptimeSeconds, "number");

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);

    const badMethod = await fetch(`${base}/health`, { method: "POST" });
    assert.equal(badMethod.status, 405);
  } finally {
    await stopHealthServer(server);
  }
}

async function testHeartbeat() {
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const received = [];
  let requestCount = 0;

  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = request.headers["x-wrightyard-signature"];
    const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
    let valid = false;
    try {
      const actual = Buffer.from(String(signature ?? "").trim(), "hex");
      valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      valid = false;
    }

    requestCount += 1;
    received.push({ raw, signature, valid });

    let payload;
    if (requestCount === 1) {
      payload = {
        ok: true,
        presence: "website line",
        status: "idle",
        maintenance: null,
        syncCommands: true,
      };
    } else if (requestCount === 2) {
      payload = {
        ok: true,
        presence: null,
        status: null,
        maintenance: true,
        syncCommands: false,
      };
    } else {
      payload = {
        ok: true,
        presence: null,
        status: null,
        maintenance: null,
        syncCommands: false,
      };
    }

    response.writeHead(valid ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(valid ? payload : { error: "Invalid signature." }));
  });

  const port = await listen(receiver);
  const state = new BotState();
  const config = {
    token: "not-used",
    clientId: "1566784935342252032",
    guildId: "1566778873985892442",
    ownerId: "971329961313046578",
    siteUrl: `http://127.0.0.1:${port}`,
    heartbeatSecret: secret,
    announcementsChannelId: null,
    ticketPanelChannelId: null,
    ticketLogChannelId: null,
    staffRoleIds: [],
    ticketCategoryId: null,
    port: 8080,
    nodeEnv: "test",
  };
  const logger = loggerStub();
  const presenceUpdates = [];
  const client = {
    user: {
      id: "1566784935342252032",
      setPresence: (data) => presenceUpdates.push(data),
    },
    guilds: {
      cache: new Map([["1566778873985892442", { memberCount: 123 }]]),
    },
    ws: { ping: 42 },
  };
  const presence = new PresenceService(client, config, state, logger);
  const tickets = { openCount: 2 };
  let syncCalls = 0;
  const heartbeat = new HeartbeatService({
    client,
    config,
    state,
    presence,
    tickets,
    logger,
    version: "1.0.0-test",
    syncCommands: async () => {
      syncCalls += 1;
      return 6;
    },
  });

  try {
    heartbeat.start();
    await delay(250);
    assert.equal(requestCount, 1);
    assert.equal(received[0].valid, true, "heartbeat signature must verify over the raw body");
    assert.equal(syncCalls, 1);
    assert.equal(presence.snapshot().source, "website");
    assert.equal(presence.snapshot().text, "website line");
    assert.equal(presence.snapshot().status, "idle");
    assert.ok(presenceUpdates.length > 0);

    heartbeat.stop();
    heartbeat.start();
    await delay(250);
    assert.equal(requestCount, 2);
    assert.equal(received[1].valid, true);
    assert.equal(state.maintenance, true);
    assert.equal(state.maintenanceSource, "website");
    assert.deepEqual(presence.snapshot(), {
      text: "Down for maintenance",
      status: "idle",
      source: "maintenance",
    });

    heartbeat.stop();
    heartbeat.start();
    await delay(250);
    assert.equal(requestCount, 3);
    assert.equal(received[2].valid, true);
    assert.equal(state.maintenance, false);
    assert.equal(state.maintenanceSource, "off");
    assert.equal(presence.snapshot().source, "rotation");

    state.setLocalMaintenance(true);
    assert.equal(state.maintenance, true);
    assert.equal(state.maintenanceSource, "local");
    assert.deepEqual(presence.snapshot(), {
      text: "Down for maintenance",
      status: "idle",
      source: "maintenance",
    });
  } finally {
    heartbeat.stop();
    await new Promise((resolve) => receiver.close(resolve));
  }
}

await testHealth();
await testHeartbeat();
console.log("smoke: health server and signed heartbeat passed");
