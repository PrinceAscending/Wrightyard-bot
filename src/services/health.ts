import { createServer, type Server } from "node:http";
import type { Client } from "discord.js";
import type { Logger } from "../logger.js";
import type { BotState } from "../state.js";

export interface HealthServerOptions {
  readonly port: number;
  readonly client: Client;
  readonly state: BotState;
  readonly version: string;
  readonly logger: Logger;
}

interface HealthBody {
  readonly ok: boolean;
  readonly uptimeSeconds: number;
  readonly ready: boolean;
  readonly guilds: number;
  readonly version: string;
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const { client, state, version, logger } = options;

  const server = createServer((request, response) => {
    try {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
        response.end("Method not allowed");
        return;
      }

      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== "/" && path !== "/health") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Not found");
        return;
      }

      const ready = client.isReady();
      const body: HealthBody = {
        ok: ready,
        uptimeSeconds: state.uptimeSeconds(),
        ready,
        guilds: client.guilds.cache.size,
        version,
      };
      const payload = JSON.stringify(body);

      response.writeHead(ready ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(method === "HEAD" ? undefined : payload);
    } catch {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "0.0.0.0");
  });

  logger.info("Health server listening", { port: options.port, path: "/health" });
  return server;
}

export async function stopHealthServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
