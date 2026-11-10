import { serializeError, type Logger } from "../logger.js";

export interface BatchQueueOptions<T> {
  readonly maxSize: number;
  readonly flushMs: number;
  readonly send: (items: readonly T[]) => Promise<void>;
  readonly logger: Logger;
}

/**
 * Accumulates items and sends them in order, one batch at a time. A batch is
 * flushed when it reaches `maxSize`, when the timer fires, or on `close()`.
 */
export class BatchQueue<T> {
  private readonly maxSize: number;
  private readonly flushMs: number;
  private readonly send: (items: readonly T[]) => Promise<void>;
  private readonly logger: Logger;
  private items: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(options: BatchQueueOptions<T>) {
    this.maxSize = Math.max(1, options.maxSize);
    this.flushMs = Math.max(0, options.flushMs);
    this.send = options.send;
    this.logger = options.logger;
  }

  public push(item: T): void {
    if (this.closed) {
      return;
    }
    this.items.push(item);
    if (this.items.length >= this.maxSize) {
      this.clearTimer();
      this.scheduleFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.scheduleFlush();
      }, this.flushMs);
      this.timer.unref();
    }
  }

  public flush(): Promise<void> {
    this.clearTimer();
    this.scheduleFlush();
    return this.chain;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    this.chain = this.chain.then(() => this.flushPending());
  }

  private async flushPending(): Promise<void> {
    while (this.items.length > 0) {
      const batch = this.items.splice(0, this.maxSize);
      try {
        await this.send(batch);
      } catch (error) {
        this.logger.warn("Audit batch send failed; dropping batch", {
          size: batch.length,
          ...serializeError(error),
        });
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
