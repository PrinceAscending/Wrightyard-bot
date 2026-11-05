import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MongoClient, type Collection } from "mongodb";
import type { Logger } from "../logger.js";
import { serializeError } from "../logger.js";

const CONNECT_TIMEOUT_MS = 5_000;
const XP_COOLDOWN_MS = 60_000;
const XP_MIN = 15;
const XP_MAX = 25;
export const MAX_LEVEL = 100;
const XP_STEP = 20;

export interface LevelRecord {
  readonly userId: string;
  readonly xp: number;
  readonly level: number;
  readonly messages: number;
  readonly lastXpAt: Date | null;
  readonly updatedAt: Date;
}

export interface XpGrant {
  readonly gained: number;
  readonly record: LevelRecord;
  readonly previousLevel: number;
  readonly leveledUp: boolean;
}

export interface LeaderboardEntry extends LevelRecord {
  readonly rank: number;
}

type LevelDoc = {
  _id: string;
  guildId: string;
  userId: string;
  xp: number;
  level: number;
  messages: number;
  lastXpAt: Date | null;
  updatedAt: Date;
};

type JsonLevel = Omit<LevelDoc, "_id" | "guildId" | "lastXpAt" | "updatedAt"> & {
  lastXpAt: string | null;
  updatedAt: string;
};

export function totalXpForLevel(level: number): number {
  const safe = Math.max(0, Math.min(MAX_LEVEL, Math.floor(level)));
  return XP_STEP * safe * safe;
}

export function levelForXp(xp: number): number {
  return Math.min(MAX_LEVEL, Math.floor(Math.sqrt(Math.max(0, xp) / XP_STEP)));
}

export function levelProgress(xp: number): {
  level: number;
  current: number;
  needed: number;
  percent: number;
} {
  const level = levelForXp(xp);
  const start = totalXpForLevel(level);
  const next = totalXpForLevel(level + 1);
  const current = Math.max(0, xp - start);
  const needed = Math.max(1, next - start);
  return {
    level,
    current,
    needed,
    percent: Math.min(100, Math.round((current / needed) * 100)),
  };
}

/**
 * XP is stored in MongoDB when configured, with an on-disk JSON fallback for
 * local development and Mongo outages. The guild is fixed, so every record is
 * keyed by user and can be read without a guild lookup.
 */
export class LevelStore {
  private readonly guildId: string;
  private readonly uri: string | null;
  private readonly dbName: string;
  private readonly logger: Logger;
  private readonly jsonPath: string;
  private readonly cooldowns = new Map<string, number>();

  private client: MongoClient | null = null;
  private collectionPromise: Promise<Collection<LevelDoc>> | null = null;
  private jsonMode: boolean;
  private jsonLoaded = false;
  private readonly jsonData = new Map<string, LevelRecord>();
  private writeTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private warnedJsonFallback = false;

  public constructor(options: {
    readonly guildId: string;
    readonly uri: string | null;
    readonly dbName: string;
    readonly logger: Logger;
  }) {
    this.guildId = options.guildId;
    this.uri = options.uri;
    this.dbName = options.dbName;
    this.logger = options.logger;
    this.jsonMode = !options.uri;
    this.jsonPath =
      process.env.LEVELS_FILE?.trim() || resolve(process.cwd(), "data", "levels.json");
  }

  public get durable(): boolean {
    return !this.jsonMode;
  }

  public async grantMessageXp(userId: string, now = Date.now()): Promise<XpGrant | null> {
    const last = this.cooldowns.get(userId) ?? 0;
    if (now - last < XP_COOLDOWN_MS) {
      return null;
    }
    this.cooldowns.set(userId, now);

    const current = (await this.read(userId)) ?? {
      userId,
      xp: 0,
      level: 0,
      messages: 0,
      lastXpAt: null,
      updatedAt: new Date(now),
    };

    const gained = randomInt(XP_MIN, XP_MAX + 1);
    const xp = current.xp + gained;
    const level = levelForXp(xp);
    const record: LevelRecord = {
      userId,
      xp,
      level,
      messages: current.messages + 1,
      lastXpAt: new Date(now),
      updatedAt: new Date(now),
    };

    await this.write(record);

    return {
      gained,
      record,
      previousLevel: current.level,
      leveledUp: level > current.level,
    };
  }

  public async getRecord(userId: string): Promise<LevelRecord | null> {
    return this.read(userId);
  }

  public async getRank(userId: string): Promise<number | null> {
    const record = await this.read(userId);
    if (!record) {
      return null;
    }

    if (this.jsonMode) {
      await this.loadJson();
      let rank = 1;
      for (const other of this.jsonData.values()) {
        if (other.xp > record.xp) rank += 1;
      }
      return rank;
    }

    try {
      const collection = await this.collection();
      const higher = await collection.countDocuments({
        guildId: this.guildId,
        xp: { $gt: record.xp },
      });
      return higher + 1;
    } catch (error) {
      this.switchToJson(error);
      return this.getRank(userId);
    }
  }

  public async getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));

    if (this.jsonMode) {
      await this.loadJson();
      return [...this.jsonData.values()]
        .sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId))
        .slice(0, safeLimit)
        .map((record, index) => ({ ...record, rank: index + 1 }));
    }

    try {
      const collection = await this.collection();
      const docs = await collection
        .find({ guildId: this.guildId })
        .sort({ xp: -1, userId: 1 })
        .limit(safeLimit)
        .toArray();
      return docs.map((doc, index) => ({
        userId: doc.userId,
        xp: doc.xp,
        level: doc.level,
        messages: doc.messages,
        lastXpAt: doc.lastXpAt,
        updatedAt: doc.updatedAt,
        rank: index + 1,
      }));
    } catch (error) {
      this.switchToJson(error);
      return this.getLeaderboard(safeLimit);
    }
  }

  public async close(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushJson();
    const client = this.client;
    this.client = null;
    this.collectionPromise = null;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  private async read(userId: string): Promise<LevelRecord | null> {
    if (this.jsonMode) {
      await this.loadJson();
      return this.jsonData.get(userId) ?? null;
    }

    try {
      const collection = await this.collection();
      const doc = await collection.findOne({ _id: `${this.guildId}:${userId}` });
      return doc ? this.fromDoc(doc) : null;
    } catch (error) {
      this.switchToJson(error);
      return this.read(userId);
    }
  }

  private async write(record: LevelRecord): Promise<void> {
    if (this.jsonMode) {
      await this.loadJson();
      this.jsonData.set(record.userId, record);
      this.scheduleJsonWrite();
      return;
    }

    try {
      const collection = await this.collection();
      await collection.updateOne(
        { _id: `${this.guildId}:${record.userId}` },
        {
          $set: {
            guildId: this.guildId,
            userId: record.userId,
            xp: record.xp,
            level: record.level,
            messages: record.messages,
            lastXpAt: record.lastXpAt,
            updatedAt: record.updatedAt,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      this.switchToJson(error);
      await this.write(record);
    }
  }

  private fromDoc(doc: LevelDoc): LevelRecord {
    return {
      userId: doc.userId,
      xp: doc.xp,
      level: doc.level,
      messages: doc.messages,
      lastXpAt: doc.lastXpAt,
      updatedAt: doc.updatedAt,
    };
  }

  private collection(): Promise<Collection<LevelDoc>> {
    if (!this.collectionPromise) {
      const client = new MongoClient(this.uri!, {
        appName: "WrightyardBot",
        maxPoolSize: 5,
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        connectTimeoutMS: CONNECT_TIMEOUT_MS,
        retryWrites: true,
      });
      this.client = client;
      this.collectionPromise = client
        .connect()
        .then(() => client.db(this.dbName).collection<LevelDoc>("levels"))
        .then(async (levels) => {
          await Promise.all([
            levels.createIndex({ guildId: 1, xp: -1 }, { name: "levels_leaderboard" }),
            levels.createIndex({ guildId: 1, userId: 1 }, { name: "levels_member" }),
          ]);
          return levels;
        })
        .catch((error: unknown) => {
          this.collectionPromise = null;
          throw error;
        });
    }
    return this.collectionPromise;
  }

  private switchToJson(error: unknown): void {
    if (this.jsonMode) {
      return;
    }
    this.jsonMode = true;
    this.collectionPromise = null;
    const client = this.client;
    this.client = null;
    void client?.close().catch(() => undefined);
    if (!this.warnedJsonFallback) {
      this.warnedJsonFallback = true;
      this.logger.warn("Level ledger is using the local JSON fallback", {
        error: serializeError(error),
        file: this.jsonPath,
      });
    }
  }

  private async loadJson(): Promise<void> {
    if (this.jsonMode === false || this.jsonLoaded) {
      return;
    }
    this.jsonLoaded = true;

    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, JsonLevel>;
      for (const [userId, value] of Object.entries(parsed)) {
        if (!value || typeof value.xp !== "number") continue;
        this.jsonData.set(userId, {
          userId,
          xp: value.xp,
          level: typeof value.level === "number" ? value.level : levelForXp(value.xp),
          messages: typeof value.messages === "number" ? value.messages : 0,
          lastXpAt: value.lastXpAt ? new Date(value.lastXpAt) : null,
          updatedAt: value.updatedAt ? new Date(value.updatedAt) : new Date(),
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn("Level ledger file could not be read; starting a new one", {
          file: this.jsonPath,
          error: serializeError(error),
        });
      }
    }
  }

  private scheduleJsonWrite(): void {
    if (this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeChain = this.writeChain.then(() => this.flushJson()).catch((error: unknown) => {
        this.logger.warn("Level ledger file could not be written", {
          file: this.jsonPath,
          error: serializeError(error),
        });
      });
    }, 250);
    this.writeTimer.unref?.();
  }

  private async flushJson(): Promise<void> {
    if (!this.jsonMode || !this.jsonLoaded) {
      return;
    }

    const payload: Record<string, JsonLevel> = {};
    for (const [userId, record] of this.jsonData) {
      payload[userId] = {
        userId,
        xp: record.xp,
        level: record.level,
        messages: record.messages,
        lastXpAt: record.lastXpAt?.toISOString() ?? null,
        updatedAt: record.updatedAt.toISOString(),
      };
    }

    await mkdir(dirname(this.jsonPath), { recursive: true });
    const temporary = `${this.jsonPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.jsonPath);
  }
}
