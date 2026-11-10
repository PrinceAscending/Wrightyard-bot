import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import type { AuditService } from "../audit/service.js";
import type { AuditSeverity } from "../audit/types.js";
import type { AntiNukeMode, Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import type { CaseStore, ModerationCase } from "../staff/cases.js";
import { evaluateSecurity, SECURITY_RULES, type SecurityDecision } from "./rules.js";
import type {
  IncidentRestorer,
  ObservedAction,
  SecurityStatePort,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 86_400_000;
const SUPPRESSION_MS = 300_000;
const RETENTION_MS = 300_000;
const QUARANTINE_ROLE_NAME = "Quarantined";

export interface SecuritySnapshot {
  readonly enabled: boolean;
  readonly mode: AntiNukeMode;
  readonly ruleCount: number;
  readonly lastAlertAt: Date | null;
}

export interface SecurityServiceOptions {
  readonly client: Client;
  readonly config: Config;
  readonly cases: CaseStore;
  readonly audit: AuditService;
  readonly restore: IncidentRestorer;
  readonly state?: SecurityStatePort;
  readonly logger: Logger;
  readonly now?: () => Date;
}

interface AlertInput {
  readonly summary: string;
  readonly severity: AuditSeverity;
  readonly actor: { id: string; tag: string };
  readonly rule: string | null;
  readonly count: number;
  readonly windowSeconds: number | null;
  readonly action: string;
  readonly caseId?: number;
  readonly metadata?: Record<string, unknown>;
  readonly channelId?: string;
}

function memberTag(member: GuildMember): string {
  return member.user.tag ?? member.user.username ?? member.id;
}

function caseNumber(value: number): string {
  return `#${String(value).padStart(4, "0")}`;
}

/**
 * Anti-nuke response ladder. Observations are cheap; evaluation runs on a
 * per-actor promise chain so a burst of gateway events cannot interleave two
 * enforcement decisions for the same actor.
 */
export class SecurityService {
  private readonly client: Client;
  private readonly config: Config;
  private readonly cases: CaseStore;
  private readonly audit: AuditService;
  private readonly restore: IncidentRestorer;
  private readonly state: SecurityStatePort | undefined;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly actions = new Map<string, ObservedAction[]>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly actionedAt = new Map<string, number>();
  private lastAlert: Date | null = null;

  public constructor(options: SecurityServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.cases = options.cases;
    this.audit = options.audit;
    this.restore = options.restore;
    this.state = options.state;
    this.logger = options.logger;
    this.clock = options.now ?? (() => new Date());
  }

  public observe(action: ObservedAction): void {
    if (!this.config.antiNukeEnabled) {
      return;
    }

    const now = this.clock().getTime();
    const retained = (this.actions.get(action.actorId) ?? []).filter(
      (entry) => now - entry.at.getTime() <= RETENTION_MS,
    );
    retained.push(action);
    this.actions.set(action.actorId, retained);

    const previous = this.chains.get(action.actorId) ?? Promise.resolve();
    const next = previous
      .then(() => this.evaluate(action.actorId))
      .catch((error: unknown) => {
        this.logger.warn("Security evaluation failed", {
          actorId: action.actorId,
          error: serializeError(error),
        });
      });
    this.chains.set(action.actorId, next);
  }

  public async flush(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  public snapshot(): SecuritySnapshot {
    return {
      enabled: this.config.antiNukeEnabled,
      mode: this.config.antiNukeMode,
      ruleCount: SECURITY_RULES.length,
      lastAlertAt: this.lastAlert,
    };
  }

  public async quarantineMember(
    member: GuildMember,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<ModerationCase | null> {
    const guild = this.guild();
    if (!guild) {
      return null;
    }

    const target = await this.fetchMember(guild, member.id);
    if (!target) {
      await this.recordAlert({
        summary: `Quarantine skipped: ${member.id} is no longer in the guild`,
        severity: "critical",
        actor: { id: member.id, tag: memberTag(member) },
        rule: this.metadataString(metadata.rule),
        count: this.metadataNumber(metadata.count),
        windowSeconds: this.metadataNumber(metadata.windowSeconds),
        action: "quarantine",
        metadata: { ...metadata, missingMember: true },
      });
      return null;
    }

    const role = await this.quarantineRole(guild);
    if (!role) {
      await this.recordAlert({
        summary: `Quarantine failed: no ${QUARANTINE_ROLE_NAME} role available`,
        severity: "critical",
        actor: { id: target.id, tag: memberTag(target) },
        rule: this.metadataString(metadata.rule),
        count: this.metadataNumber(metadata.count),
        windowSeconds: this.metadataNumber(metadata.windowSeconds),
        action: "quarantine",
        metadata: { ...metadata, quarantineRoleMissing: true },
      });
      return null;
    }

    const removedRoleIds = [...target.roles.cache.keys()].filter(
      (roleId) => roleId !== role.id,
    );
    const timeoutMs =
      typeof metadata.timeoutMs === "number" && metadata.timeoutMs > 0
        ? metadata.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    let rolesRemoved = false;
    try {
      await target.roles.set([role.id], reason);
      rolesRemoved = true;
    } catch (error) {
      this.logger.warn("Quarantine role removal failed", {
        actorId: target.id,
        error: serializeError(error),
      });
    }

    let timedOut = false;
    const me = guild.members.me;
    if (me?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
      try {
        await target.timeout(timeoutMs, reason);
        timedOut = true;
      } catch (error) {
        this.logger.warn("Quarantine timeout failed", {
          actorId: target.id,
          error: serializeError(error),
        });
      }
    }

    if (!rolesRemoved && !timedOut) {
      await this.recordAlert({
        summary: `Quarantine failed for ${memberTag(target)}: roles and timeout both rejected`,
        severity: "critical",
        actor: { id: target.id, tag: memberTag(target) },
        rule: this.metadataString(metadata.rule),
        count: this.metadataNumber(metadata.count),
        windowSeconds: this.metadataNumber(metadata.windowSeconds),
        action: "quarantine",
        metadata: { ...metadata, quarantineFailed: true },
      });
      return null;
    }

    const record = await this.cases.create({
      guildId: guild.id,
      action: "quarantine",
      targetId: target.id,
      targetTag: memberTag(target),
      moderatorId: this.client.user?.id ?? "system",
      moderatorTag: this.client.user?.tag ?? "Wrightyard",
      reason,
      metadata: {
        ...metadata,
        removedRoleIds,
        quarantineRoleId: role.id,
        ...(rolesRemoved ? {} : { quarantineFallback: "timeout" }),
        ...(timedOut ? { timeoutMs } : {}),
      },
    });

    await this.recordAlert({
      summary: `Quarantined ${memberTag(target)} · case ${caseNumber(record.caseId)}`,
      severity: "critical",
      actor: { id: target.id, tag: memberTag(target) },
      rule: this.metadataString(metadata.rule),
      count: this.metadataNumber(metadata.count),
      windowSeconds: this.metadataNumber(metadata.windowSeconds),
      action: "quarantine",
      caseId: record.caseId,
      metadata: { ...metadata, removedRoleIds },
    });
    this.audit.record({
      category: "security",
      type: "security.quarantine",
      summary: `Quarantined ${memberTag(target)} (case ${caseNumber(record.caseId)})`,
      severity: "critical",
      actor: { id: target.id, tag: memberTag(target) },
      fields: [
        { name: "Case", value: caseNumber(record.caseId), inline: true },
        { name: "Rule", value: this.metadataString(metadata.rule) ?? "unknown", inline: true },
        {
          name: "Removed roles",
          value: removedRoleIds.length > 0 ? removedRoleIds.join(", ") : "none",
        },
        {
          name: "Response",
          value: rolesRemoved ? "roles replaced" : "timeout fallback",
          inline: true,
        },
      ],
      payload: { caseId: record.caseId, ...metadata, removedRoleIds },
      feed: true,
    });

    await this.markAction(guild.id, target.id);
    await this.markAlert(guild.id);
    return record;
  }

  public async banMember(
    member: GuildMember,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<ModerationCase> {
    const guild = this.guild();
    if (!guild) {
      throw new Error("Guild is not cached; cannot ban.");
    }

    await guild.members.ban(member.id, { reason, deleteMessageSeconds: 0 });

    const record = await this.cases.create({
      guildId: guild.id,
      action: "securityBan",
      targetId: member.id,
      targetTag: memberTag(member),
      moderatorId: this.client.user?.id ?? "system",
      moderatorTag: this.client.user?.tag ?? "Wrightyard",
      reason,
      metadata,
    });

    await this.recordAlert({
      summary: `Banned ${memberTag(member)} · case ${caseNumber(record.caseId)}`,
      severity: "critical",
      actor: { id: member.id, tag: memberTag(member) },
      rule: this.metadataString(metadata.rule),
      count: this.metadataNumber(metadata.count),
      windowSeconds: this.metadataNumber(metadata.windowSeconds),
      action: "ban",
      caseId: record.caseId,
      metadata,
    });
    this.audit.record({
      category: "security",
      type: "security.ban",
      summary: `Security ban for ${memberTag(member)} (case ${caseNumber(record.caseId)})`,
      severity: "critical",
      actor: { id: member.id, tag: memberTag(member) },
      fields: [
        { name: "Case", value: caseNumber(record.caseId), inline: true },
        { name: "Rule", value: this.metadataString(metadata.rule) ?? "unknown", inline: true },
        { name: "Reason", value: reason },
      ],
      payload: { caseId: record.caseId, ...metadata },
      feed: true,
    });

    await this.markAction(guild.id, member.id);
    await this.markAlert(guild.id);
    return record;
  }

  private async evaluate(actorId: string): Promise<void> {
    const guild = this.guild();
    if (!guild) {
      return;
    }

    const now = this.clock();
    const actions = this.actions.get(actorId) ?? [];
    if (actions.length === 0) {
      return;
    }

    if (this.isExempt(guild, actorId)) {
      return;
    }

    const member = await this.fetchMember(guild, actorId);
    if (!member) {
      await this.recordAlert({
        summary: `Destructive activity from an unresolved actor (${actorId})`,
        severity: "critical",
        actor: { id: actorId, tag: "Unknown" },
        rule: null,
        count: actions.length,
        windowSeconds: null,
        action: "alert",
        metadata: { missingMember: true },
      });
      return;
    }

    if (this.hasQuarantineRole(member)) {
      return;
    }

    const actioned = this.actionedAt.get(actorId);
    if (actioned !== undefined && now.getTime() - actioned < SUPPRESSION_MS) {
      await this.recordAlert({
        summary: `Suppressed repeat activity from an already-actioned actor (${memberTag(member)})`,
        severity: "warn",
        actor: { id: member.id, tag: memberTag(member) },
        rule: null,
        count: actions.length,
        windowSeconds: null,
        action: "alert",
        metadata: { suppressed: true },
      });
      return;
    }

    const botPosition = guild.members.me?.roles?.highest?.position ?? 0;
    const actorPosition = member.roles?.highest?.position ?? 0;
    if (actorPosition >= botPosition) {
      await this.recordAlert({
        summary: `Blocked: ${memberTag(member)} is at or above the bot's role`,
        severity: "critical",
        actor: { id: member.id, tag: memberTag(member) },
        rule: null,
        count: actions.length,
        windowSeconds: null,
        action: "alert",
        metadata: { blocked: true },
      });
      return;
    }

    const decision = evaluateSecurity(actions, now, this.config.antiNukeMode);
    if (decision.action === "none") {
      return;
    }

    const metadata = this.metadataFor(decision);
    const reason = `Anti-nuke: ${decision.kind ?? "activity"} ×${decision.count} in ${decision.rule?.windowSeconds ?? 0}s`;

    if (decision.action === "alert") {
      await this.recordAlert({
        summary: `Anti-nuke alert: ${memberTag(member)} · ${decision.kind}`,
        severity: "warn",
        actor: { id: member.id, tag: memberTag(member) },
        rule: decision.kind,
        count: decision.count,
        windowSeconds: decision.rule?.windowSeconds ?? null,
        action: "alert",
        metadata: { ...metadata },
      });
      return;
    }

    let record: ModerationCase | null = null;
    if (decision.action === "ban") {
      try {
        record = await this.banMember(member, reason, metadata);
      } catch (error) {
        this.logger.warn("Security ban failed; falling back to quarantine", {
          actorId: member.id,
          error: serializeError(error),
        });
        record = await this.quarantineMember(member, reason, metadata);
      }
    } else {
      record = await this.quarantineMember(member, reason, metadata);
    }

    if (record && this.config.antiNukeRestore) {
      try {
        await this.restore.restoreIncident([...actions], "anti-nuke");
      } catch (error) {
        this.logger.warn("Incident restore failed", {
          actorId: member.id,
          error: serializeError(error),
        });
      }
    }
  }

  private metadataFor(decision: SecurityDecision): Record<string, unknown> {
    return {
      rule: decision.kind,
      count: decision.count,
      windowSeconds: decision.rule?.windowSeconds ?? null,
    };
  }

  private isExempt(guild: Guild, actorId: string): boolean {
    return (
      actorId === this.client.user?.id ||
      actorId === guild.ownerId ||
      actorId === this.config.ownerId ||
      this.config.antiNukeTrustedUserIds.includes(actorId)
    );
  }

  private hasQuarantineRole(member: GuildMember): boolean {
    const configured = this.config.antiNukeQuarantineRoleId;
    return member.roles.cache.some(
      (role: Role) =>
        role.name === QUARANTINE_ROLE_NAME || (configured !== null && role.id === configured),
    );
  }

  private async fetchMember(
    guild: Guild,
    actorId: string,
  ): Promise<GuildMember | null> {
    const cached = guild.members.cache?.get(actorId);
    if (cached) {
      return cached;
    }
    try {
      return await guild.members.fetch(actorId);
    } catch {
      return null;
    }
  }

  private async quarantineRole(guild: Guild): Promise<Role | null> {
    const configured = this.config.antiNukeQuarantineRoleId;
    if (configured) {
      const cached = guild.roles.cache.get(configured);
      if (cached) {
        return cached;
      }
      try {
        return await guild.roles.fetch(configured);
      } catch {
        // Fall through to the role name.
      }
    }

    const byName = guild.roles.cache.find(
      (role: Role) => role.name === QUARANTINE_ROLE_NAME,
    );
    if (byName) {
      return byName;
    }

    try {
      return await guild.roles.create({
        name: QUARANTINE_ROLE_NAME,
        permissions: [],
        hoist: false,
        mentionable: false,
        reason: "Anti-nuke quarantine role",
      });
    } catch (error) {
      this.logger.warn("Could not create the quarantine role", serializeError(error));
      return null;
    }
  }

  private async recordAlert(input: AlertInput): Promise<void> {
    const now = this.clock();
    this.lastAlert = now;
    await this.markAlert(this.guild()?.id ?? this.config.guildId);

    const fields = [
      { name: "Rule", value: input.rule ?? "none", inline: true },
      { name: "Count", value: String(input.count), inline: true },
      {
        name: "Window",
        value: input.windowSeconds === null ? "n/a" : `${input.windowSeconds}s`,
        inline: true,
      },
      { name: "Action", value: input.action, inline: true },
    ];
    if (input.caseId !== undefined) {
      fields.push({ name: "Case", value: caseNumber(input.caseId), inline: true });
    }

    this.audit.record({
      category: "security",
      type: "security.alert",
      summary: input.summary,
      severity: input.severity,
      actor: input.actor,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      fields,
      payload: { ...input.metadata, action: input.action },
      feed: true,
    });
  }

  private async markAction(guildId: string, actorId: string): Promise<void> {
    this.actionedAt.set(actorId, this.clock().getTime());
    try {
      await this.state?.markAction(guildId, actorId, this.clock());
    } catch (error) {
      this.logger.warn("Could not persist the security action mark", serializeError(error));
    }
  }

  private async markAlert(guildId: string): Promise<void> {
    try {
      await this.state?.markAlert(guildId, this.clock());
    } catch (error) {
      this.logger.warn("Could not persist the security alert mark", serializeError(error));
    }
  }

  private metadataString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private metadataNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private guild(): Guild | null {
    return this.client.guilds.cache.get(this.config.guildId) ?? null;
  }
}
