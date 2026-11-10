import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection } from "mongodb";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";
import type { SecurityStatePort } from "./types.js";

export interface SecurityState {
  readonly raidMode: boolean;
  readonly raidUntil: Date | null;
  readonly lastActionAt: Readonly<Record<string, string>>;
  readonly lastAlertAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface SecurityStateStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
}

interface StateDocument extends Record<string, unknown> {
  _id: string;
}

interface JsonState {
  readonly raidMode?: boolean;
  readonly raidUntil?: string | null;
  readonly lastActionAt?: Record<string, string>;
  readonly lastAlertAt?: string | null;
  readonly updatedAt?: string | null;
}

type JsonDocument = Record<string, JsonState>;

const COLLECTION = "security_state";

function emptyState(): SecurityState {
  return {
    raidMode: false,
    raidUntil: null,
    lastActionAt: {},
    lastAlertAt: null,
    updatedAt: null,
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeDocument(document: StateDocument): SecurityState {
  const actions: Record<string, string> = {};
  const rawActions = document.lastActionAt;
  if (rawActions && typeof rawActions === "object") {
    for (const [actorId, at] of Object.entries(rawActions)) {
      if (typeof at === "string") {
        actions[actorId] = at;
      }
    }
  }
  return {
    raidMode: document.raidMode === true,
    raidUntil: toDate(document.raidUntil),
    lastActionAt: actions,
    lastAlertAt: toDate(document.lastAlertAt),
    updatedAt: toDate(document.updatedAt),
  };
}

function normalizeJson(raw: JsonState): SecurityState {
  const actions: Record<string, string> = {};
  if (raw.lastActionAt && typeof raw.lastActionAt === "object") {
    for (const [actorId, at] of Object.entries(raw.lastActionAt)) {
      if (typeof at === "string") {
        actions[actorId] = at;
      }
    }
  }
  return {
    raidMode: raw.raidMode === true,
    raidUntil: toDate(raw.raidUntil),
    lastActionAt: actions,
    lastAlertAt: toDate(raw.lastAlertAt),
    updatedAt: toDate(raw.updatedAt),
  };
}

/**
 * Durable raid and anti-nuke state. Mongo is the primary store; a JSON file
 * keeps the guard working when Mongo is absent or unavailable.
 */
export class SecurityStateStore implements SecurityStatePort {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private collection: Collection<StateDocument> | null = null;
  private jsonMode = false;
  private warnedMongo = false;
  private warnedJson = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: SecurityStateStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
  }

  public async get(guildId: string): Promise<SecurityState> {
    await this.queue;

    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const document = await collection.findOne({ _id: guildId });
        return document ? normalizeDocument(document) : emptyState();
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    return all[guildId] ? normalizeJson(all[guildId]!) : emptyState();
  }

  public setRaidMode(guildId: string, until: Date | null): Promise<void> {
    const now = new Date();
    return this.enqueue(() => this.writeRaidMode(guildId, until, now));
  }

  public markAction(guildId: string, actorId: string, at: Date): Promise<void> {
    return this.enqueue(() => this.writeAction(guildId, actorId, at, new Date()));
  }

  public markAlert(guildId: string, at: Date): Promise<void> {
    return this.enqueue(() => this.writeAlert(guildId, at, new Date()));
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private async writeRaidMode(
    guildId: string,
    until: Date | null,
    now: Date,
  ): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.updateOne(
          { _id: guildId },
          {
            $set: {
              raidMode: until !== null,
              raidUntil: until,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    all[guildId] = {
      ...all[guildId],
      raidMode: until !== null,
      raidUntil: toIso(until),
      updatedAt: now.toISOString(),
    };
    await this.writeJson(all);
  }

  private async writeAction(
    guildId: string,
    actorId: string,
    at: Date,
    now: Date,
  ): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.updateOne(
          { _id: guildId },
          {
            $set: {
              [`lastActionAt.${actorId}`]: at.toISOString(),
              updatedAt: now,
            },
          },
          { upsert: true },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const current = all[guildId] ?? {};
    all[guildId] = {
      ...current,
      lastActionAt: {
        ...(current.lastActionAt ?? {}),
        [actorId]: at.toISOString(),
      },
      updatedAt: now.toISOString(),
    };
    await this.writeJson(all);
  }

  private async writeAlert(guildId: string, at: Date, now: Date): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.updateOne(
          { _id: guildId },
          {
            $set: {
              lastAlertAt: at,
              updatedAt: now,
            },
          },
          { upsert: true },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    all[guildId] = {
      ...all[guildId],
      lastAlertAt: at.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.writeJson(all);
  }

  private async mongoCollection(): Promise<Collection<StateDocument>> {
    if (this.collection) {
      return this.collection;
    }
    const collection = await this.database!.collection<StateDocument>(COLLECTION);
    this.collection = collection;
    return collection;
  }

  private async readJson(): Promise<JsonDocument> {
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as JsonDocument;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return {};
      }
      this.warnJson("Could not read the security state; starting a new file", error);
      return {};
    }
  }

  private async writeJson(all: JsonDocument): Promise<void> {
    await mkdir(dirname(this.jsonPath), { recursive: true });
    const temp = `${this.jsonPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.jsonPath);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private failMongo(error: unknown): void {
    this.jsonMode = true;
    if (!this.warnedMongo) {
      this.warnedMongo = true;
      this.logger.warn(
        "Security state Mongo store unavailable; falling back to JSON",
        serializeError(error),
      );
    }
  }

  private warnJson(message: string, error: unknown): void {
    if (this.warnedJson) {
      return;
    }
    this.warnedJson = true;
    this.logger.warn(message, serializeError(error));
  }
}
