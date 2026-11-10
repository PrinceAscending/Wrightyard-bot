import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { Config } from "../config.js";
import type { AuditService } from "../audit/service.js";
import type { AuditEventInput } from "../audit/types.js";
import { BRAND } from "../brand.js";
import { formatDuration, truncate } from "../format.js";
import { serializeError, type Logger } from "../logger.js";
import { CaseStore, type ModerationCase } from "./cases.js";
import { canModerate, type ModerationGuardInput } from "./guard.js";
import { resolveStaffRank } from "./ranks.js";

const MAX_TIMEOUT_MS = 28 * 86_400_000;
const MAX_BAN_DELETE_SECONDS = 604_800;

export class StaffGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaffGuardError";
  }
}

export function parseDuration(raw: string): number | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(raw.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const duration = amount * multiplier;
  if (duration > MAX_TIMEOUT_MS) {
    return null;
  }
  return duration;
}

function tagOf(member: GuildMember): string {
  return member.user.tag ?? member.user.username ?? member.id;
}

function positionOf(member: GuildMember): number {
  return member.roles?.highest?.position ?? 0;
}

export interface StaffActionsOptions {
  readonly client: Client;
  readonly config: Config;
  readonly cases: CaseStore;
  readonly audit: AuditService;
  readonly logger: Logger;
}

interface ActionContext {
  readonly actor: GuildMember;
  readonly target: GuildMember;
  readonly minimumRank: "moderator" | "steward";
  readonly requiredPermission?: bigint;
}

/**
 * Staff moderation actions: guard first, Discord call second, case third,
 * audit fourth. A failed Discord call records `moderation.failed` and never
 * creates a case.
 */
export class StaffActions {
  private readonly client: Client;
  private readonly config: Config;
  private readonly cases: CaseStore;
  private readonly audit: AuditService;
  private readonly logger: Logger;

  public constructor(options: StaffActionsOptions) {
    this.client = options.client;
    this.config = options.config;
    this.cases = options.cases;
    this.audit = options.audit;
    this.logger = options.logger;
  }

  public async warn(actor: GuildMember, target: GuildMember, reason: string): Promise<ModerationCase> {
    return this.runAction(
      { actor, target, minimumRank: "moderator" },
      { action: "warn", reason },
      async () => {
        await this.notify(
          target,
          `You were warned in ${BRAND.name}: ${truncate(reason, 1_500)}`,
        );
        return undefined;
      },
    );
  }

  public async timeout(
    actor: GuildMember,
    target: GuildMember,
    durationMs: number,
    reason: string,
  ): Promise<ModerationCase> {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_TIMEOUT_MS) {
      throw new Error("Timeout duration must be between 1 second and 28 days.");
    }
    return this.runAction(
      {
        actor,
        target,
        minimumRank: "moderator",
        requiredPermission: PermissionFlagsBits.ModerateMembers,
      },
      {
        action: "timeout",
        reason,
        durationMs,
        expiresAt: new Date(Date.now() + durationMs),
      },
      async () => {
        await target.timeout(durationMs, reason);
      },
    );
  }

  public async untimeout(
    actor: GuildMember,
    target: GuildMember,
    reason: string,
  ): Promise<ModerationCase> {
    const record = await this.runAction(
      {
        actor,
        target,
        minimumRank: "moderator",
        requiredPermission: PermissionFlagsBits.ModerateMembers,
      },
      { action: "untimeout", reason },
      async () => {
        await target.timeout(null, reason);
      },
    );
    await this.revokeLatest(target.guild.id, target.id, "timeout", actor.id, reason);
    return record;
  }

  public async kick(
    actor: GuildMember,
    target: GuildMember,
    reason: string,
    notify: boolean,
  ): Promise<ModerationCase> {
    return this.runAction(
      {
        actor,
        target,
        minimumRank: "moderator",
        requiredPermission: PermissionFlagsBits.KickMembers,
      },
      { action: "kick", reason },
      async () => {
        if (notify) {
          await this.notify(
            target,
            `You were removed from ${BRAND.name}: ${truncate(reason, 1_500)}`,
          );
        }
        await target.kick(reason);
      },
    );
  }

  public async ban(
    actor: GuildMember,
    target: GuildMember,
    reason: string,
    deleteSeconds: number,
    notify: boolean,
  ): Promise<ModerationCase> {
    const clamped = Math.min(
      MAX_BAN_DELETE_SECONDS,
      Math.max(0, Math.trunc(deleteSeconds)),
    );
    return this.runAction(
      {
        actor,
        target,
        minimumRank: "steward",
        requiredPermission: PermissionFlagsBits.BanMembers,
      },
      {
        action: "ban",
        reason,
        metadata: { deleteSeconds: clamped },
      },
      async () => {
        if (notify) {
          await this.notify(
            target,
            `You were banned from ${BRAND.name}: ${truncate(reason, 1_500)}`,
          );
        }
        await target.ban({ reason, deleteMessageSeconds: clamped });
      },
    );
  }

  public async unban(
    actor: GuildMember,
    userId: string,
    reason: string,
  ): Promise<ModerationCase> {
    const guild = this.guild();
    this.assertGuard({
      actorId: actor.id,
      actorRank: resolveStaffRank(actor, this.config),
      actorPosition: positionOf(actor),
      targetId: userId,
      targetPosition: 0,
      guildOwnerId: guild.ownerId,
      botId: this.client.user?.id,
      botPosition: this.botPosition(guild),
      botPermissions: guild.members.me?.permissions,
      config: this.config,
      minimumRank: "steward",
      requiredPermission: PermissionFlagsBits.BanMembers,
      skipHierarchy: true,
    });

    try {
      await guild.bans.remove(userId, reason);
    } catch (error) {
      this.recordFailure("unban", actor, userId, error);
      throw error;
    }

    const record = await this.cases.create({
      guildId: guild.id,
      action: "unban",
      targetId: userId,
      targetTag: userId,
      moderatorId: actor.id,
      moderatorTag: tagOf(actor),
      reason,
    });
    await this.revokeLatest(guild.id, userId, "ban", actor.id, reason);
    this.audit.record(this.actionEvent(record, actor));
    return record;
  }

  public async clearWarnings(
    actor: GuildMember,
    target: GuildMember,
    reason: string,
  ): Promise<ModerationCase> {
    this.assertGuard(this.guardInput(actor, target, "steward"));
    const warnings = await this.cases.list(target.guild.id, {
      targetId: target.id,
      action: "warn",
      status: "open",
      limit: 100,
    });
    for (const warning of warnings) {
      await this.cases.updateStatus(
        target.guild.id,
        warning.caseId,
        "revoked",
        actor.id,
        reason,
      );
    }
    const record = await this.cases.create({
      guildId: target.guild.id,
      action: "warnClear",
      targetId: target.id,
      targetTag: tagOf(target),
      moderatorId: actor.id,
      moderatorTag: tagOf(actor),
      reason,
      metadata: { cleared: warnings.map((warning) => warning.caseId) },
    });
    this.audit.record(this.actionEvent(record, actor));
    return record;
  }

  public listWarnings(target: GuildMember): Promise<ModerationCase[]> {
    return this.cases.list(target.guild.id, {
      targetId: target.id,
      action: "warn",
      status: "open",
      limit: 100,
    });
  }

  public note(actor: GuildMember, target: GuildMember, text: string): Promise<ModerationCase> {
    return this.runAction(
      { actor, target, minimumRank: "moderator" },
      { action: "note", reason: text },
      async () => undefined,
    );
  }

  public listNotes(target: GuildMember): Promise<ModerationCase[]> {
    return this.cases.list(target.guild.id, {
      targetId: target.id,
      action: "note",
      limit: 100,
    });
  }

  public async report(
    reporter: GuildMember,
    target: GuildMember,
    reason: string,
  ): Promise<ModerationCase> {
    const record = await this.cases.create({
      guildId: target.guild.id,
      action: "report",
      targetId: target.id,
      targetTag: tagOf(target),
      moderatorId: reporter.id,
      moderatorTag: tagOf(reporter),
      reason,
      metadata: { reporterId: reporter.id },
    });
    this.audit.record({
      category: "moderation",
      type: "moderation.report",
      summary: `Report against ${tagOf(target)} (case #${String(record.caseId).padStart(4, "0")})`,
      severity: "warn",
      actor: { id: reporter.id, tag: tagOf(reporter) },
      target: { id: target.id, name: tagOf(target) },
      fields: [
        { name: "Case", value: `#${String(record.caseId).padStart(4, "0")}`, inline: true },
        { name: "Target", value: `${tagOf(target)} (${target.id})`, inline: true },
        { name: "Reporter", value: `${tagOf(reporter)} (${reporter.id})`, inline: true },
        { name: "Reason", value: truncate(reason || "No reason provided", 1_000) },
      ],
      payload: { caseId: record.caseId, reporterId: reporter.id },
    });
    return record;
  }

  public async resolveCase(
    actor: GuildMember,
    caseId: number,
    note?: string,
  ): Promise<ModerationCase> {
    const guild = this.guild();
    this.assertGuard({
      actorId: actor.id,
      actorRank: resolveStaffRank(actor, this.config),
      actorPosition: positionOf(actor),
      targetId: "",
      targetPosition: 0,
      guildOwnerId: guild.ownerId,
      botId: this.client.user?.id,
      botPosition: this.botPosition(guild),
      botPermissions: guild.members.me?.permissions,
      config: this.config,
      minimumRank: "moderator",
      skipHierarchy: true,
    });

    const existing = await this.cases.get(guild.id, caseId);
    if (!existing) {
      throw new Error(`Case #${String(caseId).padStart(4, "0")} was not found.`);
    }
    if (existing.status !== "open") {
      throw new Error(
        `Case #${String(caseId).padStart(4, "0")} is ${existing.status}, not open.`,
      );
    }

    await this.cases.updateStatus(guild.id, caseId, "closed", actor.id, note);
    const record = await this.cases.create({
      guildId: guild.id,
      action: "caseResolve",
      targetId: existing.targetId,
      targetTag: existing.targetTag,
      moderatorId: actor.id,
      moderatorTag: tagOf(actor),
      reason: note ?? `Case #${String(caseId).padStart(4, "0")} resolved`,
      metadata: { resolvedCaseId: caseId },
    });
    this.audit.record(this.actionEvent(record, actor));
    return record;
  }

  private async runAction(
    context: ActionContext,
    details: {
      readonly action: ModerationCase["action"];
      readonly reason: string;
      readonly durationMs?: number;
      readonly expiresAt?: Date;
      readonly metadata?: Record<string, unknown>;
    },
    call: () => Promise<unknown>,
  ): Promise<ModerationCase> {
    this.assertGuard(this.guardInput(context.actor, context.target, context.minimumRank, context.requiredPermission));
    try {
      await call();
    } catch (error) {
      this.recordFailure(details.action, context.actor, context.target.id, error);
      throw error;
    }

    const record = await this.cases.create({
      guildId: context.target.guild.id,
      action: details.action,
      targetId: context.target.id,
      targetTag: tagOf(context.target),
      moderatorId: context.actor.id,
      moderatorTag: tagOf(context.actor),
      reason: details.reason,
      ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
      ...(details.expiresAt ? { expiresAt: details.expiresAt } : {}),
      ...(details.metadata ? { metadata: details.metadata } : {}),
    });
    this.audit.record(this.actionEvent(record, context.actor));
    return record;
  }

  private guardInput(
    actor: GuildMember,
    target: GuildMember,
    minimumRank: "moderator" | "steward",
    requiredPermission?: bigint,
  ): ModerationGuardInput {
    const guild = target.guild;
    return {
      actorId: actor.id,
      actorRank: resolveStaffRank(actor, this.config),
      actorPosition: positionOf(actor),
      targetId: target.id,
      targetPosition: positionOf(target),
      targetIsBot: Boolean(target.user.bot),
      guildOwnerId: guild.ownerId,
      botId: this.client.user?.id,
      botPosition: this.botPosition(guild),
      botPermissions: guild.members.me?.permissions,
      config: this.config,
      minimumRank,
      ...(requiredPermission !== undefined ? { requiredPermission } : {}),
    };
  }

  private assertGuard(input: ModerationGuardInput): void {
    const result = canModerate(input);
    if (!result.ok) {
      throw new StaffGuardError(result.reason);
    }
  }

  private botPosition(guild: Guild): number {
    return guild.members.me?.roles?.highest?.position ?? 0;
  }

  private guild(): Guild {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) {
      throw new Error("Guild is not cached; cannot perform this action.");
    }
    return guild;
  }

  private async revokeLatest(
    guildId: string,
    targetId: string,
    action: "timeout" | "ban",
    actorId: string,
    note: string,
  ): Promise<void> {
    const [open] = await this.cases.list(guildId, {
      targetId,
      action,
      status: "open",
      limit: 1,
    });
    if (!open) {
      return;
    }
    await this.cases.updateStatus(guildId, open.caseId, "revoked", actorId, note);
  }

  private actionEvent(record: ModerationCase, actor: GuildMember): AuditEventInput {
    return {
      category: "moderation",
      type: "moderation.action",
      summary: `${record.action}: ${record.targetTag ?? record.targetId ?? "unknown"} (case #${String(record.caseId).padStart(4, "0")})`,
      severity: record.action === "ban" || record.action === "kick" ? "warn" : "info",
      actor: { id: actor.id, tag: tagOf(actor) },
      ...(record.targetId
        ? { target: { id: record.targetId, ...(record.targetTag ? { name: record.targetTag } : {}) } }
        : {}),
      fields: [
        { name: "Case", value: `#${String(record.caseId).padStart(4, "0")}`, inline: true },
        { name: "Action", value: record.action, inline: true },
        { name: "Target", value: record.targetTag ?? record.targetId ?? "unknown", inline: true },
        { name: "Reason", value: truncate(record.reason || "No reason provided", 1_000) },
        ...(record.durationMs
          ? [{ name: "Duration", value: formatDuration(record.durationMs / 1_000), inline: true }]
          : []),
      ],
      payload: { caseId: record.caseId, action: record.action },
    };
  }

  private recordFailure(
    action: string,
    actor: GuildMember,
    targetId: string,
    error: unknown,
  ): void {
    this.logger.warn("Staff action failed", {
      action,
      actorId: actor.id,
      targetId,
      error: serializeError(error),
    });
    this.audit.record({
      category: "moderation",
      type: "moderation.failed",
      summary: `${action} failed for ${targetId}: ${error instanceof Error ? error.name : "UnknownError"}`,
      severity: "warn",
      actor: { id: actor.id, tag: tagOf(actor) },
      target: { id: targetId },
      fields: [
        { name: "Action", value: action, inline: true },
        {
          name: "Error",
          value: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      ],
      payload: { action, targetId },
    });
  }

  private async notify(target: GuildMember, content: string): Promise<void> {
    try {
      await target.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.warn("Staff DM failed", {
        targetId: target.id,
        error: serializeError(error),
      });
    }
  }
}
