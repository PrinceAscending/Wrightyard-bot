import {
  ActivityType,
  type ActivitiesOptions,
  type Client,
  type PresenceStatusData,
} from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotState } from "../state.js";

export type BotStatus = PresenceStatusData;
export type PresenceSource = "rotation" | "local" | "website" | "maintenance";

export interface PresenceSnapshot {
  readonly text: string;
  readonly status: BotStatus;
  readonly source: PresenceSource;
}

interface RotationEntry {
  readonly kind: "watching" | "playing";
  readonly text: string;
}

const ROTATION_MS = 25_000;

export function isBotStatus(value: unknown): value is BotStatus {
  return value === "online" || value === "idle" || value === "dnd" || value === "invisible";
}

export class PresenceService {
  private readonly client: Client;
  private readonly config: Config;
  private readonly state: BotState;
  private readonly logger: Logger;
  private readonly localOverride: { text: string | null; status: BotStatus | null } = {
    text: null,
    status: null,
  };
  private readonly websiteOverride: { text: string | null; status: BotStatus | null } = {
    text: null,
    status: null,
  };
  private rotationIndex = 0;
  private timer: NodeJS.Timeout | null = null;

  public constructor(client: Client, config: Config, state: BotState, logger: Logger) {
    this.client = client;
    this.config = config;
    this.state = state;
    this.logger = logger;
  }

  public start(): void {
    if (this.timer) {
      return;
    }

    this.apply();
    this.timer = setInterval(() => {
      if (this.state.maintenance || this.hasOverride()) {
        return;
      }
      this.rotationIndex = (this.rotationIndex + 1) % this.rotationEntries().length;
      this.apply();
    }, ROTATION_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public setLocalOverride(text: string, status: BotStatus): void {
    this.localOverride.text = text;
    this.localOverride.status = status;
  }

  public clearLocalOverride(): void {
    this.localOverride.text = null;
    this.localOverride.status = null;
    this.refresh();
  }

  public setWebsiteText(text: string | null): boolean {
    if (this.websiteOverride.text === text) {
      return false;
    }
    this.websiteOverride.text = text;
    return true;
  }

  public setWebsiteStatus(status: BotStatus | null): boolean {
    if (this.websiteOverride.status === status) {
      return false;
    }
    this.websiteOverride.status = status;
    return true;
  }

  public clearWebsiteOverride(): void {
    this.websiteOverride.text = null;
    this.websiteOverride.status = null;
  }

  public hasWebsiteOverride(): boolean {
    return this.websiteOverride.text !== null || this.websiteOverride.status !== null;
  }

  public refresh(): void {
    this.apply();
  }

  public snapshot(): PresenceSnapshot {
    if (this.state.maintenance) {
      return { text: "Down for maintenance", status: "idle", source: "maintenance" };
    }

    const rotation = this.rotationEntries()[this.rotationIndex] ?? this.rotationEntries()[0];
    const hasWebsite = this.hasWebsiteOverride();
    const hasLocal = this.localOverride.text !== null || this.localOverride.status !== null;

    return {
      text: this.websiteOverride.text ?? this.localOverride.text ?? rotation?.text ?? "the gate",
      status: this.websiteOverride.status ?? this.localOverride.status ?? "online",
      source: hasWebsite ? "website" : hasLocal ? "local" : "rotation",
    };
  }

  private hasOverride(): boolean {
    return (
      this.hasWebsiteOverride() ||
      this.localOverride.text !== null ||
      this.localOverride.status !== null
    );
  }

  private rotationEntries(): RotationEntry[] {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    const memberCount = guild?.memberCount ?? 0;

    return [
      { kind: "watching", text: "the quiet machinery" },
      { kind: "watching", text: memberCount > 0 ? `${memberCount} in the yard` : "the yard" },
      { kind: "playing", text: "/status for the yard" },
      { kind: "watching", text: "the gate" },
      { kind: "watching", text: "Software, built here. Kept running." },
    ];
  }

  private apply(): void {
    const user = this.client.user;
    if (!user) {
      return;
    }

    const current = this.snapshot();
    try {
      user.setPresence({
        activities: [this.activityFor(current.text, current.source)],
        status: current.status,
      });
    } catch (error) {
      this.logger.warn("Presence update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private activityFor(text: string, source: PresenceSource): ActivitiesOptions {
    if (source === "rotation") {
      const current = this.rotationEntries()[this.rotationIndex];
      if (current?.kind === "playing") {
        return { name: text, type: ActivityType.Playing };
      }
    }

    return { name: text, type: ActivityType.Watching };
  }
}
