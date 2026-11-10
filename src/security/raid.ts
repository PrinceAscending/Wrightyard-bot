import type { GuildMember } from "discord.js";
import type { AuditService } from "../audit/service.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import type { ModerationCase } from "../staff/cases.js";
import type { SecurityStatePort } from "./types.js";

const DAY_MS = 86_400_000;
const QUARANTINE_TIMEOUT_MS = 3_600_000;
const KICK_REASON = "Raid guard: account too new during a join flood.";
const QUARANTINE_REASON = "Raid guard: join during a join flood.";

export interface RaidSnapshot {
  readonly active: boolean;
  readonly activeUntil: Date | null;
  readonly joinsInWindow: number;
}

export interface RaidSecurity {
  quarantineMember(
    member: GuildMember,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<ModerationCase | null>;
}

export interface RaidGuardOptions {
  readonly config: Config;
  readonly security: RaidSecurity;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly state?: SecurityStatePort;
  readonly now?: () => Date;
}

/**
 * Tracks join velocity and contains new accounts while a raid window is open.
 * The guard only ever acts on humans and never blocks the normal welcome path
 * when a containment attempt fails.
 */
export class RaidGuard {
  private readonly config: Config;
  private readonly security: RaidSecurity;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly state: SecurityStatePort | undefined;
  private readonly clock: () => Date;
  private joins: number[] = [];
  private activeUntil: Date | null = null;

  public constructor(options: RaidGuardOptions) {
    this.config = options.config;
    this.security = options.security;
    this.audit = options.audit;
    this.logger = options.logger;
    this.state = options.state;
    this.clock = options.now ?? (() => new Date());
  }

  public get active(): boolean {
    return this.activeUntil !== null;
  }

  public snapshot(): RaidSnapshot {
    const now = this.clock();
    if (this.activeUntil && now.getTime() > this.activeUntil.getTime()) {
      this.activeUntil = null;
      void this.persist(null);
    }
    return {
      active: this.active,
      activeUntil: this.activeUntil,
      joinsInWindow: this.prune(now.getTime()).length,
    };
  }

  public async observeJoin(member: GuildMember): Promise<{ contained: boolean }> {
    if (!this.config.raidGuardEnabled || member.user.bot) {
      return { contained: false };
    }

    const now = this.clock();
    const nowMs = now.getTime();
    if (this.activeUntil && nowMs > this.activeUntil.getTime()) {
      await this.setActive(false, "raid window expired");
    }

    this.prune(nowMs);
    this.joins.push(nowMs);

    if (this.active) {
      await this.extend(now);
      return this.contain(member, now);
    }

    if (this.joins.length >= this.config.raidJoinThreshold) {
      await this.setActive(true, "join flood");
      return this.contain(member, now);
    }

    return { contained: false };
  }

  public async restoreState(): Promise<void> {
    if (!this.state) {
      return;
    }
    try {
      const state = await this.state.get(this.config.guildId);
      const now = this.clock();
      if (
        state.raidMode &&
        state.raidUntil &&
        state.raidUntil.getTime() > now.getTime()
      ) {
        this.activeUntil = state.raidUntil;
        return;
      }
      if (state.raidMode || state.raidUntil !== null) {
        this.activeUntil = null;
        await this.state.setRaidMode(this.config.guildId, null);
      }
    } catch (error) {
      this.logger.warn("Could not restore the raid guard state", serializeError(error));
    }
  }

  public async setActive(active: boolean, reason: string): Promise<void> {
    const now = this.clock();
    if (active) {
      const wasActive = this.active;
      const base = Math.max(now.getTime(), this.activeUntil?.getTime() ?? 0);
      const until = new Date(base + this.config.raidModeMinutes * 60_000);
      this.activeUntil = until;
      if (!wasActive) {
        this.recordRaid(true, reason, until);
      }
      await this.persist(until);
      return;
    }

    if (!this.active) {
      await this.persist(null);
      return;
    }

    this.activeUntil = null;
    this.recordRaid(false, reason, null);
    await this.persist(null);
  }

  private async contain(
    member: GuildMember,
    now: Date,
  ): Promise<{ contained: boolean }> {
    const createdTimestamp = member.user.createdTimestamp;
    const ageDays = Number.isFinite(createdTimestamp)
      ? (now.getTime() - createdTimestamp) / DAY_MS
      : Number.POSITIVE_INFINITY;

    if (ageDays < this.config.raidMinAccountAgeDays) {
      try {
        await member.kick(KICK_REASON);
        this.recordContainment(member, "kick", ageDays);
        return { contained: true };
      } catch (error) {
        this.logger.warn("Raid guard could not kick a young account", {
          userId: member.id,
          error: serializeError(error),
        });
        return { contained: false };
      }
    }

    try {
      const record = await this.security.quarantineMember(member, QUARANTINE_REASON, {
        raid: true,
        timeoutMs: QUARANTINE_TIMEOUT_MS,
        rule: "join flood",
      });
      if (!record) {
        this.logger.warn("Raid guard quarantine returned no case", {
          userId: member.id,
        });
        return { contained: false };
      }
      this.recordContainment(member, "quarantine", ageDays);
      return { contained: true };
    } catch (error) {
      this.logger.warn("Raid guard could not quarantine a join", {
        userId: member.id,
        error: serializeError(error),
      });
      return { contained: false };
    }
  }

  private async extend(now: Date): Promise<void> {
    const base = Math.max(now.getTime(), this.activeUntil?.getTime() ?? now.getTime());
    const until = new Date(base + this.config.raidModeMinutes * 60_000);
    this.activeUntil = until;
    await this.persist(until);
  }

  private prune(nowMs: number): number[] {
    const windowMs = this.config.raidWindowSeconds * 1_000;
    this.joins = this.joins.filter((at) => nowMs - at <= windowMs);
    return this.joins;
  }

  private async persist(until: Date | null): Promise<void> {
    if (!this.state) {
      return;
    }
    try {
      await this.state.setRaidMode(this.config.guildId, until);
    } catch (error) {
      this.logger.warn("Could not persist the raid mode", serializeError(error));
    }
  }

  private recordRaid(
    active: boolean,
    reason: string,
    until: Date | null,
  ): void {
    try {
      this.audit.record({
        category: "security",
        type: "security.raid",
        summary: active ? "Raid mode enabled" : "Raid mode disabled",
        severity: active ? "critical" : "info",
        fields: [
          { name: "Mode", value: active ? "active" : "inactive", inline: true },
          {
            name: "Until",
            value: until ? until.toISOString() : "n/a",
            inline: true,
          },
          {
            name: "Joins in window",
            value: String(this.joins.length),
            inline: true,
          },
          { name: "Reason", value: reason },
        ],
        payload: {
          active,
          until: until ? until.toISOString() : null,
          joinsInWindow: this.joins.length,
          reason,
        },
      });
    } catch (error) {
      this.logger.warn("Could not record the raid mode change", serializeError(error));
    }
  }

  private recordContainment(
    member: GuildMember,
    action: "kick" | "quarantine",
    accountAgeDays: number,
  ): void {
    try {
      this.audit.record({
        category: "security",
        type: "security.raid",
        summary: `Raid guard ${action === "kick" ? "kicked" : "quarantined"} a join`,
        severity: "critical",
        actor: { id: member.id, tag: member.user.tag ?? member.user.username ?? member.id },
        fields: [
          { name: "Action", value: action, inline: true },
          {
            name: "Account age",
            value: `${Math.max(0, Math.floor(accountAgeDays))}d`,
            inline: true,
          },
          {
            name: "Joins in window",
            value: String(this.joins.length),
            inline: true,
          },
        ],
        payload: {
          action,
          accountAgeDays,
          joinsInWindow: this.joins.length,
        },
      });
    } catch (error) {
      this.logger.warn("Could not record raid containment", serializeError(error));
    }
  }
}
