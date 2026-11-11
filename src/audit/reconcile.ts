import { AuditLogEvent, type Client, type Guild } from "discord.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import type { AuditCursorStore } from "./cursors.js";
import type { AuditService } from "./service.js";
import type { AuditCategory, AuditEventInput } from "./types.js";

interface AuditEntryLike {
  readonly id: string;
  readonly action: number;
  readonly targetId?: string | null;
  readonly executorId?: string | null;
  readonly executor?: { readonly id: string; readonly tag: string } | null;
  readonly reason?: string | null;
  readonly createdTimestamp: number;
}

interface SeenPort {
  has(key: string): Promise<boolean> | boolean;
  add(key: string): Promise<void> | void;
}

export interface AuditReconcilerOptions {
  readonly client: Client;
  readonly config: Config;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly cursors: AuditCursorStore;
  readonly seen?: SeenPort;
  readonly intervalMs?: number;
  readonly staggerMs?: number;
}

const PAGE_SIZE = 25;
const STAGGER_MS = 250;

const RECONCILED_TYPES: readonly AuditLogEvent[] = [
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberKick,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.EmojiDelete,
  AuditLogEvent.StickerDelete,
  AuditLogEvent.InviteCreate,
  AuditLogEvent.ThreadDelete,
  AuditLogEvent.GuildUpdate,
  AuditLogEvent.MessageBulkDelete,
];

const MAPPING: Partial<Record<AuditLogEvent, { type: string; category: AuditCategory }>> = {
  [AuditLogEvent.ChannelCreate]: { type: "channel.create", category: "server" },
  [AuditLogEvent.ChannelDelete]: { type: "channel.delete", category: "server" },
  [AuditLogEvent.RoleCreate]: { type: "role.create", category: "server" },
  [AuditLogEvent.RoleDelete]: { type: "role.delete", category: "server" },
  [AuditLogEvent.MemberRoleUpdate]: { type: "member.roles", category: "moderation" },
  [AuditLogEvent.MemberBanAdd]: { type: "member.ban", category: "moderation" },
  [AuditLogEvent.MemberBanRemove]: { type: "member.unban", category: "moderation" },
  [AuditLogEvent.MemberKick]: { type: "member.kick", category: "moderation" },
  [AuditLogEvent.WebhookCreate]: { type: "webhook.create", category: "server" },
  [AuditLogEvent.WebhookDelete]: { type: "webhook.delete", category: "server" },
  [AuditLogEvent.EmojiDelete]: { type: "emoji.delete", category: "server" },
  [AuditLogEvent.StickerDelete]: { type: "sticker.delete", category: "server" },
  [AuditLogEvent.InviteCreate]: { type: "invite.create", category: "server" },
  [AuditLogEvent.ThreadDelete]: { type: "thread.delete", category: "server" },
  [AuditLogEvent.GuildUpdate]: { type: "guild.update", category: "server" },
  [AuditLogEvent.MessageBulkDelete]: { type: "message.bulkDelete", category: "message" },
};

function newer(a: string, b: string | null): boolean {
  if (b === null) {
    return true;
  }
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
}

function newestId(entries: readonly AuditEntryLike[]): string | null {
  let newest: string | null = null;
  for (const entry of entries) {
    if (newest === null || newer(entry.id, newest)) {
      newest = entry.id;
    }
  }
  return newest;
}

function oldestId(entries: readonly AuditEntryLike[]): string | null {
  let oldest: string | null = null;
  for (const entry of entries) {
    if (oldest === null || newer(oldest, entry.id)) {
      oldest = entry.id;
    }
  }
  return oldest;
}

const delay = (ms: number): Promise<void> => {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Backfills native Discord audit-log entries the gateway recorders could not
 * attribute, one cursor per action type. Archive only: this is evidence, not a
 * second live feed.
 */
export class AuditReconciler {
  private readonly client: Client;
  private readonly config: Config;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly cursors: AuditCursorStore;
  private readonly seen: SeenPort | undefined;
  private readonly intervalMs: number;
  private readonly staggerMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(options: AuditReconcilerOptions) {
    this.client = options.client;
    this.config = options.config;
    this.audit = options.audit;
    this.logger = options.logger;
    this.cursors = options.cursors;
    this.seen = options.seen;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
    this.staggerMs = Math.max(0, options.staggerMs ?? STAGGER_MS);
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const guild = this.client.guilds.cache.get(this.config.guildId);
      if (!guild) {
        return;
      }
      for (const [index, type] of RECONCILED_TYPES.entries()) {
        await this.pollType(guild, type);
        if (index < RECONCILED_TYPES.length - 1) {
          await delay(this.staggerMs);
        }
      }
    } catch (error) {
      this.logger.warn("Audit reconciliation failed", serializeError(error));
    } finally {
      this.running = false;
    }
  }

  private async pollType(guild: Guild, type: AuditLogEvent): Promise<void> {
    const key = String(type);
    const mapping = MAPPING[type];
    if (!mapping) {
      return;
    }

    try {
      const cursor = await this.cursors.get(key);
      let before: string | undefined;
      let newest = cursor;
      let pages = 0;

      while (pages < 10) {
        pages += 1;
        const page = (await guild.fetchAuditLogs({
          type,
          limit: PAGE_SIZE,
          ...(cursor ? { after: cursor } : {}),
          ...(before ? { before } : {}),
        })) as unknown as { entries: { values(): IterableIterator<AuditEntryLike> } };
        const entries = [...page.entries.values()];
        if (entries.length === 0) {
          break;
        }

        const pageNewest = newestId(entries);
        if (cursor === null) {
          newest = pageNewest;
          break;
        }

        for (const entry of entries) {
          if (!newer(entry.id, cursor)) {
            continue;
          }
          if (await this.isDuplicate(entry.id)) {
            continue;
          }
          const event = this.toEvent(entry, mapping);
          if (event) {
            this.audit.record(event);
            await this.markSeen(entry.id);
          }
        }
        if (pageNewest && (newest === null || newer(pageNewest, newest))) {
          newest = pageNewest;
        }

        if (entries.length < PAGE_SIZE) {
          break;
        }
        const oldest = oldestId(entries);
        if (!oldest || oldest === before) {
          break;
        }
        before = oldest;
      }

      if (newest && newest !== cursor) {
        await this.cursors.set(key, newest);
      }
    } catch (error) {
      this.logger.warn("Audit reconciliation failed for type", {
        type,
        ...serializeError(error),
      });
    }
  }

  private toEvent(
    entry: AuditEntryLike,
    mapping: { type: string; category: AuditCategory },
  ): AuditEventInput | null {
    if (entry.executorId && entry.executorId === this.client.user?.id) {
      return null;
    }
    return {
      category: mapping.category,
      type: mapping.type,
      summary: `Native audit: ${mapping.type} (${entry.id})`,
      severity: "warn",
      feed: false,
      ...(entry.executor
        ? { actor: { id: entry.executor.id, tag: entry.executor.tag } }
        : {}),
      ...(entry.targetId ? { target: { id: entry.targetId } } : {}),
      fields: [
        { name: "Entry", value: entry.id, inline: true },
        ...(entry.targetId
          ? [{ name: "Target", value: entry.targetId, inline: true }]
          : []),
        ...(entry.reason ? [{ name: "Reason", value: entry.reason }] : []),
      ],
      payload: { reconciled: true, entryId: entry.id, action: entry.action },
    };
  }

  private async isDuplicate(entryId: string): Promise<boolean> {
    if (!this.seen) {
      return false;
    }
    return this.seen.has(entryId);
  }

  private async markSeen(entryId: string): Promise<void> {
    if (this.seen) {
      await this.seen.add(entryId);
    }
  }
}
