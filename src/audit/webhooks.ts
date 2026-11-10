import { AuditLogEvent, PermissionFlagsBits, type Guild } from "discord.js";
import { serializeError, type Logger } from "../logger.js";
import type { SecurityObserver } from "../security/types.js";
import type { AuditLogResolver } from "./attribution.js";

interface WebhookLike {
  readonly id: string;
}

interface WebhookChannelLike {
  readonly id: string;
  readonly name?: string;
  isTextBased?(): boolean;
  permissionsFor?(member: unknown): { has(flag: bigint): boolean } | null;
  fetchWebhooks(): Promise<{ values(): IterableIterator<WebhookLike> }>;
}

interface WebhookGuildLike {
  readonly channels: { readonly cache: { values(): IterableIterator<WebhookChannelLike> } };
  readonly members?: { readonly me?: unknown };
}

export interface WebhookTrackerOptions {
  readonly resolver: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly logger: Logger;
}

/**
 * Tracks webhook IDs per channel so a newly appearing webhook can be attributed
 * and reported even though Discord only emits a generic channel update.
 */
export class WebhookTracker {
  private readonly resolver: AuditLogResolver;
  private readonly security: SecurityObserver | undefined;
  private readonly logger: Logger;
  private readonly baseline = new Map<string, Set<string>>();
  private readonly warnedPermissions = new Set<string>();
  private readonly warnedFetch = new Set<string>();

  public constructor(options: WebhookTrackerOptions) {
    this.resolver = options.resolver;
    this.security = options.security;
    this.logger = options.logger;
  }

  public async warm(guild: Guild): Promise<void> {
    const source = guild as unknown as WebhookGuildLike;
    for (const channel of source.channels.cache.values()) {
      if (channel.isTextBased && !channel.isTextBased()) {
        continue;
      }
      if (!this.canInspect(channel, source)) {
        if (!this.warnedPermissions.has(channel.id)) {
          this.warnedPermissions.add(channel.id);
          this.logger.warn("Skipping webhook baseline without ManageWebhooks", {
            channelId: channel.id,
          });
        }
        continue;
      }
      try {
        const webhooks = await channel.fetchWebhooks();
        this.baseline.set(channel.id, new Set([...webhooks.values()].map((hook) => hook.id)));
      } catch (error) {
        this.logFetchFailure(channel.id, error);
      }
    }
  }

  public async handle(channel: WebhookChannelLike | { readonly id: string }): Promise<void> {
    const target = channel as WebhookChannelLike;
    try {
      const webhooks = await target.fetchWebhooks();
      const current = new Set([...webhooks.values()].map((hook) => hook.id));
      const previous = this.baseline.get(target.id);
      if (!previous) {
        this.baseline.set(target.id, current);
        return;
      }

      const added = [...current].filter((id) => !previous.has(id));
      this.baseline.set(target.id, current);
      for (const webhookId of added) {
        await this.observeCreate(target, webhookId);
      }
    } catch (error) {
      this.logFetchFailure(target.id, error);
    }
  }

  public forget(channelId: string): void {
    this.baseline.delete(channelId);
  }

  private async observeCreate(channel: WebhookChannelLike, webhookId: string): Promise<void> {
    if (!this.security) {
      return;
    }
    const guild = (channel as unknown as { guild?: Guild }).guild;
    if (!guild) {
      return;
    }
    const actor =
      (await this.resolver.resolve(
        guild,
        AuditLogEvent.WebhookCreate,
        webhookId,
        new Date(Date.now() - 10_000),
      )) ?? { id: "unknown", tag: "Unknown" };
    this.security.observe({
      kind: "webhookCreate",
      guildId: guild.id,
      actorId: actor.id,
      actorTag: actor.tag,
      targetId: webhookId,
      targetName: channel.name ?? null,
      at: new Date(),
      payload: { channelId: channel.id },
    });
  }

  private canInspect(channel: WebhookChannelLike, guild: WebhookGuildLike): boolean {
    if (!channel.permissionsFor || !guild.members?.me) {
      return true;
    }
    return channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageWebhooks) ?? false;
  }

  private logFetchFailure(channelId: string, error: unknown): void {
    if (this.warnedFetch.has(channelId)) {
      return;
    }
    this.warnedFetch.add(channelId);
    this.logger.warn("Could not read webhooks for channel", {
      channelId,
      ...serializeError(error),
    });
  }
}
