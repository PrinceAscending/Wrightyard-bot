import type { Client } from "discord.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import { BatchQueue } from "./batch.js";
import { logChannelName, type AuditChannelMap } from "./channels.js";
import { buildAuditEmbed } from "./format.js";
import type { AuditEvent } from "./types.js";

export interface AuditSink {
  enqueue(event: AuditEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface SendableChannel {
  send(options: {
    embeds: ReturnType<typeof buildAuditEmbed>[];
    allowedMentions: { users?: string[]; parse?: never[] };
  }): Promise<unknown>;
}

export interface AuditDispatcherOptions {
  readonly client: Client;
  readonly config: Config;
  readonly logger: Logger;
  readonly resolveChannels: () => AuditChannelMap;
}

const MAX_BATCH = 10;
const FLUSH_MS = 1_000;

function isSendable(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}

/**
 * Routes audit events into one batched queue per Discord channel. Channels are
 * looked up lazily so provisioning or a reconnect can swap them at runtime.
 */
export class AuditDispatcher implements AuditSink {
  private readonly client: Client;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly resolveChannels: () => AuditChannelMap;
  private readonly queues = new Map<string, BatchQueue<AuditEvent>>();
  private readonly warnedMissing = new Set<string>();
  private readonly warnedSend = new Set<string>();
  private closed = false;

  public constructor(options: AuditDispatcherOptions) {
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger;
    this.resolveChannels = options.resolveChannels;
  }

  public enqueue(event: AuditEvent): void {
    if (this.closed || logChannelName(event.category) === null) {
      return;
    }
    const channelId = this.resolveChannels().get(event.category);
    if (!channelId) {
      if (!this.warnedMissing.has(event.category)) {
        this.warnedMissing.add(event.category);
        this.logger.warn("No audit channel configured for category", {
          category: event.category,
        });
      }
      return;
    }
    this.queueFor(channelId).push(event);
  }

  public async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.flush()));
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private queueFor(channelId: string): BatchQueue<AuditEvent> {
    const existing = this.queues.get(channelId);
    if (existing) {
      return existing;
    }
    const queue = new BatchQueue<AuditEvent>({
      maxSize: MAX_BATCH,
      flushMs: FLUSH_MS,
      logger: this.logger,
      send: (events) => this.send(channelId, events),
    });
    this.queues.set(channelId, queue);
    return queue;
  }

  private async send(channelId: string, events: readonly AuditEvent[]): Promise<void> {
    const channel = this.client.channels.cache.get(channelId);
    if (!isSendable(channel)) {
      this.warnOnce(channelId, "Audit channel is missing or not sendable", { channelId });
      return;
    }

    const allowedMentions = events.some((event) => event.category === "security")
      ? { users: [this.config.ownerId] }
      : { parse: [] as never[] };

    try {
      await channel.send({
        embeds: events.map((event) => buildAuditEmbed(event)),
        allowedMentions,
      });
    } catch (error) {
      this.warnOnce(channelId, "Audit channel send failed; dropping batch", {
        channelId,
        size: events.length,
        ...serializeError(error),
      });
    }
  }

  private warnOnce(channelId: string, message: string, fields: Record<string, unknown>): void {
    if (this.warnedSend.has(channelId)) {
      return;
    }
    this.warnedSend.add(channelId);
    this.logger.warn(message, fields);
  }
}
