import { createHmac } from "node:crypto";
import type { Client } from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { serializeError } from "../logger.js";
import type { BotState } from "../state.js";
import { isBotStatus, type PresenceService } from "./presence.js";
import type { TicketService } from "../tickets/service.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
const AUTO_SYNC_INTERVAL_MS = 60_000;
// Mirrors the website's heartbeat schema so a very old process keeps reporting
// instead of being rejected with a 422.
const MAX_REPORTED_UPTIME_SECONDS = 31_536_000;
const MAX_REPORTED_PING_MS = 60_000;

export interface HeartbeatSnapshot {
  readonly configured: boolean;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureReason: string | null;
}

interface HeartbeatBody {
  readonly botId: string;
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly ping: number;
  readonly guilds: number;
  readonly members: number;
  readonly commandsServed: number;
  readonly openTickets: number;
  readonly presence: string;
  readonly maintenance: boolean;
  readonly memoryMb: number;
  readonly lastCommandAt: string | null;
}

interface HeartbeatServiceOptions {
  readonly client: Client;
  readonly config: Config;
  readonly state: BotState;
  readonly presence: PresenceService;
  readonly tickets: TicketService;
  readonly logger: Logger;
  readonly version: string;
  readonly syncCommands: () => Promise<number>;
}

export class HeartbeatService {
  private readonly client: Client;
  private readonly config: Config;
  private readonly state: BotState;
  private readonly presence: PresenceService;
  private readonly tickets: TicketService;
  private readonly logger: Logger;
  private readonly version: string;
  private readonly syncCommands: () => Promise<number>;
  private timer: NodeJS.Timeout | null = null;
  private controller: AbortController | null = null;
  private inFlight = false;
  private lastAttemptAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastFailureAt: Date | null = null;
  private lastFailureReason: string | null = null;
  private lastFailureLoggedAt = 0;
  private lastAutoSyncAt = 0;
  private hasSucceeded = false;

  public constructor(options: HeartbeatServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.state = options.state;
    this.presence = options.presence;
    this.tickets = options.tickets;
    this.logger = options.logger;
    this.version = options.version;
    this.syncCommands = options.syncCommands;
  }

  public get configured(): boolean {
    return Boolean(this.config.siteUrl && this.config.heartbeatSecret);
  }

  public start(): void {
    if (this.timer || !this.configured) {
      if (!this.configured) {
        this.logger.info("Website heartbeat is disabled (SITE_URL or BOT_HEARTBEAT_SECRET is missing).");
      }
      return;
    }

    this.logger.info("Website heartbeat started", { intervalSeconds: HEARTBEAT_INTERVAL_MS / 1000 });
    this.timer = setInterval(() => {
      void this.run();
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    void this.run();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  public snapshot(): HeartbeatSnapshot {
    return {
      configured: this.configured,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
    };
  }

  private async run(): Promise<void> {
    if (!this.configured || this.inFlight) {
      return;
    }

    const siteUrl = this.config.siteUrl;
    const secret = this.config.heartbeatSecret;
    if (!siteUrl || !secret) {
      return;
    }

    this.inFlight = true;
    this.lastAttemptAt = new Date();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref();

    try {
      const body = this.buildBody();
      const raw = JSON.stringify(body);
      const signature = createHmac("sha256", secret).update(raw).digest("hex");

      const response = await fetch(`${siteUrl}/api/bot/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wrightyard-signature": signature,
          accept: "application/json",
          "user-agent": `WrightyardBot/${this.version}`,
        },
        body: raw,
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.text().catch(() => "");
        this.recordFailure(`HTTP ${response.status}`);
        return;
      }

      this.lastSuccessAt = new Date();
      this.lastFailureReason = null;

      if (!this.hasSucceeded) {
        this.hasSucceeded = true;
        this.logger.info("Website heartbeat accepted");
      } else {
        this.logger.debug("Website heartbeat accepted");
      }

      const payload = await response.json().catch(() => null);
      if (payload === null) {
        return;
      }
      if (!isRecord(payload)) {
        this.logger.debug("Heartbeat response was not an object; ignoring.");
        return;
      }

      await this.applyResponse(payload);
    } catch (error) {
      if (isAbortError(error)) {
        this.recordFailure("timeout");
      } else {
        this.recordFailure("network");
        this.logger.debug("Heartbeat transport error", { error: serializeError(error) });
      }
    } finally {
      clearTimeout(timeout);
      this.controller = null;
      this.inFlight = false;
    }
  }

  private buildBody(): HeartbeatBody {
    const guilds = [...this.client.guilds.cache.values()];
    const members = guilds.reduce((total, guild) => total + guild.memberCount, 0);
    const ping = Math.min(MAX_REPORTED_PING_MS, Math.max(0, Math.round(this.client.ws.ping)));

    return {
      botId: this.client.user?.id ?? this.config.clientId,
      version: this.version,
      startedAt: this.state.startedAt.toISOString(),
      uptimeSeconds: Math.min(this.state.uptimeSeconds(), MAX_REPORTED_UPTIME_SECONDS),
      ping,
      guilds: guilds.length,
      members,
      commandsServed: this.state.commandsServed,
      openTickets: this.tickets.openCount,
      presence: this.presence.snapshot().text,
      maintenance: this.state.maintenance,
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      lastCommandAt: this.state.lastCommandAt?.toISOString() ?? null,
    };
  }

  private async applyResponse(payload: Record<string, unknown>): Promise<void> {
    let presenceChanged = false;
    let maintenanceChanged = false;

    if (Object.hasOwn(payload, "presence")) {
      const value = payload.presence;
      if (value === null) {
        presenceChanged = this.presence.setWebsiteText(null) || presenceChanged;
      } else if (typeof value === "string" && value.trim().length > 0 && value.length <= 128) {
        presenceChanged = this.presence.setWebsiteText(value.trim()) || presenceChanged;
      } else {
        this.logger.warn("Heartbeat returned an invalid presence override; ignoring.");
      }
    }

    if (Object.hasOwn(payload, "status")) {
      const value = payload.status;
      if (value === null) {
        presenceChanged = this.presence.setWebsiteStatus(null) || presenceChanged;
      } else if (isBotStatus(value)) {
        presenceChanged = this.presence.setWebsiteStatus(value) || presenceChanged;
      } else {
        this.logger.warn("Heartbeat returned an invalid status override; ignoring.");
      }
    }

    if (Object.hasOwn(payload, "maintenance")) {
      const value = payload.maintenance;
      if (value === null || typeof value === "boolean") {
        maintenanceChanged = this.state.setWebsiteMaintenance(value);
      } else {
        this.logger.warn("Heartbeat returned an invalid maintenance value; ignoring.");
      }
    }

    if (presenceChanged || maintenanceChanged) {
      this.presence.refresh();
      this.logger.info("Heartbeat applied website overrides", {
        presenceOverride: this.presence.hasWebsiteOverride(),
        maintenance: this.state.maintenance,
      });
    }

    if (payload.syncCommands === true) {
      await this.applySyncRequest();
    }
  }

  private async applySyncRequest(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAutoSyncAt < AUTO_SYNC_INTERVAL_MS) {
      this.logger.warn("Heartbeat requested a command sync again too soon; skipping.");
      return;
    }
    this.lastAutoSyncAt = now;

    try {
      const count = await this.syncCommands();
      this.logger.info("Heartbeat command sync complete", { count });
    } catch (error) {
      this.logger.error("Heartbeat command sync failed", { error: serializeError(error) });
    }
  }

  private recordFailure(reason: string): void {
    this.lastFailureAt = new Date();
    this.lastFailureReason = reason;

    const now = Date.now();
    if (now - this.lastFailureLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      this.lastFailureLoggedAt = now;
      this.logger.warn("Website heartbeat failed; the bot will keep running.", { reason });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
