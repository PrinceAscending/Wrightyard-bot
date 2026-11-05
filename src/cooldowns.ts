/**
 * Small in-memory cooldown ledger. Expired entries are swept opportunistically
 * so a long-running process does not accumulate one key per user forever.
 */
export class CooldownStore {
  private readonly until = new Map<string, number>();

  public remainingMs(key: string, now = Date.now()): number {
    const expiresAt = this.until.get(key);
    if (expiresAt === undefined) {
      return 0;
    }
    if (expiresAt <= now) {
      this.until.delete(key);
      return 0;
    }
    return expiresAt - now;
  }

  public start(key: string, seconds: number, now = Date.now()): void {
    if (seconds <= 0) {
      return;
    }
    this.until.set(key, now + seconds * 1000);
    this.sweep(now);
  }

  public clear(key: string): void {
    this.until.delete(key);
  }

  private sweep(now: number): void {
    if (this.until.size < 500) {
      return;
    }
    for (const [key, expiresAt] of this.until) {
      if (expiresAt <= now) {
        this.until.delete(key);
      }
    }
  }
}
