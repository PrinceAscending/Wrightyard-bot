import { randomUUID } from "node:crypto";
import { serializeError, type Logger } from "../logger.js";
import type { AuditSink } from "./dispatcher.js";
import type { AuditStore } from "./store.js";
import { createAuditEvent, type AuditEvent, type AuditEventInput } from "./types.js";

export interface AuditServiceOptions {
  readonly guildId: string;
  readonly store: AuditStore;
  readonly sink: AuditSink;
  readonly logger: Logger;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

/**
 * Single entry point for recording audit events. Writes are archived first and
 * only then fed to the live log channels; a failed archive still feeds security
 * alerts so an incident is never silently lost.
 */
export class AuditService {
  private readonly guildId: string;
  private readonly store: AuditStore;
  private readonly sink: AuditSink;
  private readonly logger: Logger;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly inflight = new Set<Promise<void>>();
  private failed: AuditEvent[] = [];

  public constructor(options: AuditServiceOptions) {
    this.guildId = options.guildId;
    this.store = options.store;
    this.sink = options.sink;
    this.logger = options.logger;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  public record(input: AuditEventInput): void {
    const event = createAuditEvent(input, this.guildId, this.idFactory(), this.now());
    const task = this.append(event);
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  public async recordNow(input: AuditEventInput): Promise<AuditEvent> {
    const event = createAuditEvent(input, this.guildId, this.idFactory(), this.now());
    await this.append(event);
    return event;
  }

  public async flush(): Promise<void> {
    await Promise.all([...this.inflight]);
    await this.retryFailed();
    await this.sink.flush();
  }

  public async close(): Promise<void> {
    await this.flush();
    if (this.failed.length > 0) {
      this.logger.error("Audit events could not be persisted and are being dropped", {
        count: this.failed.length,
        ids: this.failed.slice(0, 10).map((event) => event.id),
      });
    }
    await this.store.close();
    await this.sink.close();
  }

  private async append(event: AuditEvent): Promise<void> {
    try {
      await this.store.append(event);
    } catch (error) {
      this.failed.push(event);
      this.logger.warn("Audit archive append failed", {
        id: event.id,
        category: event.category,
        ...serializeError(error),
      });
    }
    if (event.feed) {
      this.sink.enqueue(event);
    }
  }

  private async retryFailed(): Promise<void> {
    const pending = this.failed;
    this.failed = [];
    for (const event of pending) {
      try {
        await this.store.append(event);
      } catch (error) {
        this.failed.push(event);
        this.logger.warn("Audit archive retry failed", {
          id: event.id,
          ...serializeError(error),
        });
      }
    }
  }
}
