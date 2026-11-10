import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import type { AuditService } from "../audit/service.js";
import type { AuditEventInput } from "../audit/types.js";
import type { Config } from "../config.js";
import { truncate } from "../format.js";
import { serializeError, type Logger } from "../logger.js";
import { CaseStore, type ModerationCase } from "./cases.js";
import { StaffGuardError } from "./actions.js";
import { canModerate } from "./guard.js";
import { resolveStaffRank } from "./ranks.js";

const FOURTEEN_DAYS_MS = 14 * 86_400_000;
const MAX_PURGE = 100;
const MAX_SLOWMODE = 21_600;

export interface PurgeMessageLike {
  readonly id: string;
  readonly content: string;
  readonly author: { readonly id: string };
  readonly createdTimestamp: number;
}

export interface PurgeFilter {
  readonly memberId?: string;
  readonly contains?: string;
}

export function parsePurgeFilter(
  filter: PurgeFilter,
): (message: PurgeMessageLike) => boolean {
  const needle = filter.contains?.toLowerCase();
  return (message) =>
    (!filter.memberId || message.author.id === filter.memberId) &&
    (!needle || message.content.toLowerCase().includes(needle));
}

export interface StaffChannelLike {
  readonly id: string;
  readonly name?: string | null;
  readonly guild: Guild;
  readonly messages: {
    fetch(options: { limit: number }): Promise<{ values(): IterableIterator<PurgeMessageLike> }>;
    bulkDelete(ids: readonly string[], filterOld?: boolean): Promise<unknown>;
  };
  readonly permissionOverwrites: {
    edit(
      target: unknown,
      options: Record<string, boolean | null>,
      editOptions?: { reason?: string },
    ): Promise<unknown>;
  };
  permissionsFor(member: GuildMember | null): { has(permission: bigint): boolean } | null;
  setRateLimitPerUser(seconds: number, reason?: string): Promise<unknown>;
}

export interface StaffChannelActionsOptions {
  readonly client: Client;
  readonly config: Config;
  readonly cases: CaseStore;
  readonly audit: AuditService;
  readonly logger: Logger;
}

export interface PurgeResult {
  readonly deletedIds: string[];
  readonly skipped: number;
}

function tagOf(member: GuildMember): string {
  return member.user.tag ?? member.user.username ?? member.id;
}

function positionOf(member: GuildMember): number {
  return member.roles?.highest?.position ?? 0;
}

export class StaffChannelActions {
  private readonly client: Client;
  private readonly config: Config;
  private readonly cases: CaseStore;
  private readonly audit: AuditService;
  private readonly logger: Logger;

  public constructor(options: StaffChannelActionsOptions) {
    this.client = options.client;
    this.config = options.config;
    this.cases = options.cases;
    this.audit = options.audit;
    this.logger = options.logger;
  }

  public async purge(
    actor: GuildMember,
    channel: StaffChannelLike,
    count: number,
    filter: PurgeFilter = {},
  ): Promise<PurgeResult> {
    this.assertChannelPermission(actor, channel, PermissionFlagsBits.ManageMessages, "Manage Messages");

    const limit = Math.max(1, Math.min(MAX_PURGE, Math.trunc(count)));
    try {
      const fetched = await channel.messages.fetch({ limit });
      const messages = [...fetched.values()];
      const predicate = parsePurgeFilter(filter);
      const matched = messages.filter(predicate);
      const now = Date.now();
      const deletable = matched.filter(
        (message) => now - message.createdTimestamp <= FOURTEEN_DAYS_MS,
      );
      const skipped = matched.length - deletable.length;
      const deletedIds = deletable.map((message) => message.id);

      if (deletedIds.length > 0) {
        await channel.messages.bulkDelete(deletedIds, true);
      }

      const record = await this.cases.create({
        guildId: channel.guild.id,
        action: "purge",
        targetId: filter.memberId ?? null,
        moderatorId: actor.id,
        moderatorTag: tagOf(actor),
        reason: `Purged ${deletedIds.length} message${deletedIds.length === 1 ? "" : "s"} in ${this.channelName(channel)}`,
        channelId: channel.id,
        metadata: {
          deleted: deletedIds.length,
          skipped,
          ...(filter.memberId ? { memberId: filter.memberId } : {}),
          ...(filter.contains ? { contains: filter.contains } : {}),
        },
      });
      this.audit.record(this.actionEvent(record, actor, channel));
      return { deletedIds, skipped };
    } catch (error) {
      this.recordFailure("purge", actor, channel, error);
      throw error;
    }
  }

  public lock(actor: GuildMember, channel: StaffChannelLike): Promise<ModerationCase> {
    return this.changeChannel(
      actor,
      channel,
      "lock",
      () =>
        channel.permissionOverwrites.edit(
          channel.guild.roles.everyone,
          { SendMessages: false },
          { reason: `Channel locked by ${tagOf(actor)}` },
        ),
      `Locked ${this.channelName(channel)}`,
    );
  }

  public unlock(actor: GuildMember, channel: StaffChannelLike): Promise<ModerationCase> {
    return this.changeChannel(
      actor,
      channel,
      "unlock",
      () =>
        channel.permissionOverwrites.edit(
          channel.guild.roles.everyone,
          { SendMessages: null },
          { reason: `Channel unlocked by ${tagOf(actor)}` },
        ),
      `Unlocked ${this.channelName(channel)}`,
    );
  }

  public slowmode(
    actor: GuildMember,
    channel: StaffChannelLike,
    seconds: number,
  ): Promise<ModerationCase> {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SLOWMODE) {
      return Promise.reject(
        new Error(`Slowmode must be between 0 and ${MAX_SLOWMODE} seconds.`),
      );
    }
    return this.changeChannel(
      actor,
      channel,
      "slowmode",
      () =>
        channel.setRateLimitPerUser(
          seconds,
          `Slowmode set by ${tagOf(actor)}`,
        ),
      seconds === 0
        ? `Slowmode disabled in ${this.channelName(channel)}`
        : `Slowmode set to ${seconds}s in ${this.channelName(channel)}`,
      { slowmode: seconds },
    );
  }

  private async changeChannel(
    actor: GuildMember,
    channel: StaffChannelLike,
    action: "lock" | "unlock" | "slowmode",
    call: () => Promise<unknown>,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ModerationCase> {
    this.assertChannelPermission(actor, channel, PermissionFlagsBits.ManageChannels, "Manage Channels");
    try {
      await call();
    } catch (error) {
      this.recordFailure(action, actor, channel, error);
      throw error;
    }

    const record = await this.cases.create({
      guildId: channel.guild.id,
      action,
      moderatorId: actor.id,
      moderatorTag: tagOf(actor),
      reason,
      channelId: channel.id,
      metadata,
    });
    this.audit.record(this.actionEvent(record, actor, channel));
    return record;
  }

  private assertChannelPermission(
    actor: GuildMember,
    channel: StaffChannelLike,
    permission: bigint,
    permissionName: string,
  ): void {
    const guild = channel.guild;
    const guard = canModerate({
      actorId: actor.id,
      actorRank: resolveStaffRank(actor, this.config),
      actorPosition: positionOf(actor),
      targetId: channel.id,
      targetPosition: 0,
      guildOwnerId: guild.ownerId,
      botId: this.client.user?.id,
      botPosition: guild.members.me?.roles?.highest?.position ?? 0,
      botPermissions: guild.members.me?.permissions,
      config: this.config,
      minimumRank: "moderator",
      skipHierarchy: true,
    });
    if (!guard.ok) {
      throw new StaffGuardError(guard.reason);
    }

    const me = guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions?.has(permission)) {
      throw new StaffGuardError(
        `I need ${permissionName} in ${this.channelName(channel)} to do that.`,
      );
    }
  }

  private channelName(channel: StaffChannelLike): string {
    return channel.name ? `#${channel.name}` : channel.id;
  }

  private actionEvent(
    record: ModerationCase,
    actor: GuildMember,
    channel: StaffChannelLike,
  ): AuditEventInput {
    return {
      category: "moderation",
      type: "moderation.action",
      summary: `${record.action} in ${this.channelName(channel)} (case #${String(record.caseId).padStart(4, "0")})`,
      severity: "info",
      actor: { id: actor.id, tag: tagOf(actor) },
      channelId: channel.id,
      fields: [
        { name: "Case", value: `#${String(record.caseId).padStart(4, "0")}`, inline: true },
        { name: "Action", value: record.action, inline: true },
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Reason", value: truncate(record.reason || "No reason provided", 1_000) },
      ],
      payload: { caseId: record.caseId, action: record.action },
    };
  }

  private recordFailure(
    action: string,
    actor: GuildMember,
    channel: StaffChannelLike,
    error: unknown,
  ): void {
    this.logger.warn("Staff channel action failed", {
      action,
      actorId: actor.id,
      channelId: channel.id,
      error: serializeError(error),
    });
    this.audit.record({
      category: "moderation",
      type: "moderation.failed",
      summary: `${action} failed in ${this.channelName(channel)}: ${error instanceof Error ? error.name : "UnknownError"}`,
      severity: "warn",
      actor: { id: actor.id, tag: tagOf(actor) },
      channelId: channel.id,
      fields: [
        { name: "Action", value: action, inline: true },
        {
          name: "Error",
          value: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
      ],
      payload: { action },
    });
  }
}
