import type { Logger } from "../logger.js";
import { serializeError } from "../logger.js";
import type { CaseStore } from "./cases.js";
import type { DutyStore } from "./duty.js";

export interface MaintenanceServiceOptions {
  readonly guildId: string;
  readonly cases: CaseStore;
  readonly duty: DutyStore;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface MaintenanceResult {
  readonly expiredCases: number;
  readonly staleDutySessions: number;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Startup cleanup plus a lightweight periodic expiry sweep. Errors are logged
 * and swallowed so a failed sweep can never take the gateway process down.
 */
export class MaintenanceService {
  private readonly guildId: string;
  private readonly cases: CaseStore;
  private readonly duty: DutyStore;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private staleDutySessions = 0;

  public constructor(options: MaintenanceServiceOptions) {
    this.guildId = options.guildId;
    this.cases = options.cases;
    this.duty = options.duty;
    this.logger = options.logger;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  public async initialize(): Promise<number> {
    try {
      this.staleDutySessions = await this.duty.closeStaleSessions(this.guildId);
    } catch (error) {
      this.staleDutySessions = 0;
      this.logger.warn("Could not close stale duty sessions", serializeError(error));
    }
    return this.staleDutySessions;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runOnce(now: Date = new Date()): Promise<MaintenanceResult> {
    if (this.running) {
      return {
        expiredCases: 0,
        staleDutySessions: this.staleDutySessions,
      };
    }

    this.running = true;
    let expiredCases = 0;
    try {
      expiredCases = await this.cases.markExpired(this.guildId, now);
    } catch (error) {
      this.logger.warn("Could not expire moderation cases", serializeError(error));
    } finally {
      this.running = false;
    }

    return {
      expiredCases,
      staleDutySessions: this.staleDutySessions,
    };
  }
}
