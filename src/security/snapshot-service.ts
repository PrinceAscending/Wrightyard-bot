import type { Guild } from "discord.js";
import type { AuditService } from "../audit/service.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import { captureSnapshot, type GuildSnapshot, type SnapshotStore } from "./snapshot.js";

export interface SnapshotServiceOptions {
  readonly getGuild: () => Guild | null;
  readonly store: SnapshotStore;
  readonly audit: AuditService;
  readonly config: Config;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/**
 * Periodically captures the restorable guild shape. The in-memory `last`
 * snapshot is available even when the durable store is unavailable.
 */
export class SnapshotService {
  private readonly getGuild: () => Guild | null;
  private readonly store: SnapshotStore;
  private readonly audit: AuditService;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshot: GuildSnapshot | null = null;
  private warned = false;

  public constructor(options: SnapshotServiceOptions) {
    this.getGuild = options.getGuild;
    this.store = options.store;
    this.audit = options.audit;
    this.config = options.config;
    this.logger = options.logger;
    this.intervalMs = Math.max(
      1_000,
      options.intervalMs ?? this.config.snapshotIntervalMinutes * 60_000,
    );
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    void this.captureNow().catch((error: unknown) => this.logCaptureError(error));
    this.timer = setInterval(() => {
      void this.captureNow().catch((error: unknown) => this.logCaptureError(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async captureNow(): Promise<GuildSnapshot> {
    const guild = this.getGuild();
    if (!guild) {
      throw new Error("Guild is not available.");
    }

    const snapshot = captureSnapshot(guild);
    await this.store.save(snapshot);
    this.lastSnapshot = snapshot;
    this.warned = false;

    this.audit.record({
      category: "security",
      type: "security.snapshot",
      summary: "Guild snapshot captured",
      severity: "info",
      fields: [
        { name: "Roles", value: String(snapshot.roles.length), inline: true },
        { name: "Channels", value: String(snapshot.channels.length), inline: true },
        { name: "Captured", value: snapshot.capturedAt.toISOString(), inline: true },
      ],
      payload: {
        capturedAt: snapshot.capturedAt.toISOString(),
        roles: snapshot.roles.length,
        channels: snapshot.channels.length,
      },
      feed: false,
    });

    return snapshot;
  }

  public last(): GuildSnapshot | null {
    return this.lastSnapshot;
  }

  private logCaptureError(error: unknown): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    this.logger.warn("Guild snapshot capture failed", serializeError(error));
  }
}
