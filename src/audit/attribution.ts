import type { AuditLogEvent, Guild } from "discord.js";
import { serializeError, type Logger } from "../logger.js";
import type { AuditActor, AuditEventInput } from "./types.js";

export interface AuditSeenStore {
  has(key: string): Promise<boolean> | boolean;
  add(key: string): Promise<void> | void;
}

export interface AuditLogResolverOptions {
  /** Used to ignore the bot's own audit-log entries. */
  readonly client?: { readonly user?: { readonly id: string } | null } | null;
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  /** Optional dedupe store; Task 28 wires attendance tracking through it. */
  readonly seen?: AuditSeenStore;
}

interface AuditEntryLike {
  readonly id: string;
  readonly targetId?: string | null;
  readonly executorId?: string | null;
  readonly createdTimestamp: number;
  readonly executor?: { readonly id: string; readonly tag: string } | null;
}

interface AuditPageLike {
  readonly entries: { values(): IterableIterator<AuditEntryLike> };
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_DELAY_MS = 500;
const CLOCK_SKEW_MS = 1_500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AuditLogResolver {
  private readonly client: AuditLogResolverOptions["client"];
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly seen: AuditSeenStore | undefined;

  public constructor(options: AuditLogResolverOptions) {
    this.client = options.client ?? null;
    this.logger = options.logger;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_ATTEMPTS);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_DELAY_MS);
    this.delay = options.delay ?? wait;
    this.seen = options.seen;
  }

  public async resolve(
    guild: Guild,
    type: AuditLogEvent,
    targetId: string | null,
    since: Date,
  ): Promise<AuditActor | null> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const entries = await this.fetch(guild, type);
      for (const entry of entries) {
        if (!this.matches(entry, targetId, since) || !entry.executor) {
          continue;
        }
        if (this.seen && (await this.seen.has(entry.id))) {
          continue;
        }
        if (this.seen) {
          await this.seen.add(entry.id);
        }
        return { id: entry.executor.id, tag: entry.executor.tag };
      }
      if (attempt < this.maxAttempts) {
        await this.delay(this.retryDelayMs);
      }
    }
    return null;
  }

  public async resolveMany(
    guild: Guild,
    type: AuditLogEvent,
    targetIds: readonly string[],
    since: Date,
  ): Promise<Map<string, AuditActor>> {
    const wanted = new Set(targetIds);
    const found = new Map<string, AuditActor>();
    const seenEntries = new Set<string>();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const entries = await this.fetch(guild, type);
      for (const entry of entries) {
        if (seenEntries.has(entry.id) || !entry.targetId || !wanted.has(entry.targetId)) {
          continue;
        }
        if (!this.matches(entry, entry.targetId, since) || !entry.executor) {
          continue;
        }
        if (this.seen && (await this.seen.has(entry.id))) {
          continue;
        }
        seenEntries.add(entry.id);
        found.set(entry.targetId, { id: entry.executor.id, tag: entry.executor.tag });
        if (this.seen) {
          await this.seen.add(entry.id);
        }
      }
      if (found.size >= wanted.size) {
        break;
      }
      if (attempt < this.maxAttempts) {
        await this.delay(this.retryDelayMs);
      }
    }

    return found;
  }

  private matches(entry: AuditEntryLike, targetId: string | null, since: Date): boolean {
    if (entry.createdTimestamp < since.getTime() - CLOCK_SKEW_MS) {
      return false;
    }
    if (targetId !== null && entry.targetId !== targetId) {
      return false;
    }
    if (!entry.executorId || !entry.executor) {
      return false;
    }
    return entry.executorId !== this.client?.user?.id;
  }

  private async fetch(guild: Guild, type: AuditLogEvent): Promise<AuditEntryLike[]> {
    try {
      const page = (await guild.fetchAuditLogs({ type, limit: 25 })) as unknown as AuditPageLike;
      return [...page.entries.values()];
    } catch (error) {
      this.logger.debug("Audit log fetch failed", serializeError(error));
      return [];
    }
  }
}

export function attributionFailureEvent(input: {
  guildId: string;
  type: string;
  targetId: string | null;
  targetName: string | null;
}): AuditEventInput {
  return {
    category: "security",
    type: "security.alert",
    summary: `Could not attribute ${input.type}${input.targetName ? ` on ${input.targetName}` : ""}`,
    severity: "critical",
    feed: true,
    actor: { id: "unknown", tag: "Unknown" },
    target: input.targetId
      ? { id: input.targetId, ...(input.targetName ? { name: input.targetName } : {}) }
      : undefined,
    fields: [
      { name: "Action", value: input.type, inline: true },
      {
        name: "Guild",
        value: input.guildId,
        inline: true,
      },
    ],
    payload: { attribution: "failed", action: input.type },
  };
}
