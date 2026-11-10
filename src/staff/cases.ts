import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection, Filter } from "mongodb";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";

export type CaseAction =
  | "warn"
  | "timeout"
  | "untimeout"
  | "kick"
  | "ban"
  | "unban"
  | "purge"
  | "lock"
  | "unlock"
  | "slowmode"
  | "note"
  | "warnClear"
  | "caseResolve"
  | "report"
  | "quarantine"
  | "securityBan";

export type CaseStatus = "open" | "closed" | "expired" | "revoked";

export interface ModerationCase {
  readonly caseId: number;
  readonly guildId: string;
  readonly action: CaseAction;
  readonly targetId: string | null;
  readonly targetTag: string | null;
  readonly moderatorId: string;
  readonly moderatorTag: string;
  readonly reason: string;
  readonly durationMs: number | null;
  readonly expiresAt: Date | null;
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly status: CaseStatus;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewCase {
  readonly guildId: string;
  readonly action: CaseAction;
  readonly targetId?: string | null;
  readonly targetTag?: string | null;
  readonly moderatorId: string;
  readonly moderatorTag?: string;
  readonly reason?: string;
  readonly durationMs?: number | null;
  readonly expiresAt?: Date | null;
  readonly channelId?: string | null;
  readonly messageId?: string | null;
  readonly status?: CaseStatus;
  readonly metadata?: Record<string, unknown>;
}

export interface CaseFilter {
  readonly targetId?: string;
  readonly moderatorId?: string;
  readonly action?: CaseAction;
  readonly status?: CaseStatus;
  readonly since?: Date;
  readonly limit?: number;
}

export interface CaseStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
}

interface CaseDocument extends Record<string, unknown> {
  _id: string;
}

interface CounterDocument {
  readonly _id: string;
  readonly seq: number;
}

interface JsonCase {
  caseId: number;
  guildId: string;
  action: CaseAction;
  targetId: string | null;
  targetTag: string | null;
  moderatorId: string;
  moderatorTag: string;
  reason: string;
  durationMs: number | null;
  expiresAt: string | null;
  channelId: string | null;
  messageId: string | null;
  status: CaseStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface GuildCases {
  nextCaseId: number;
  cases: JsonCase[];
}

type JsonDocument = Record<string, GuildCases>;

const CASES = "mod_cases";
const COUNTERS = "counters";
const IMMEDIATE_CLOSE: ReadonlySet<CaseAction> = new Set<CaseAction>([
  "kick",
  "purge",
  "lock",
  "unlock",
  "slowmode",
  "note",
  "unban",
  "untimeout",
  "warnClear",
  "caseResolve",
]);

function defaultStatus(action: CaseAction): CaseStatus {
  return IMMEDIATE_CLOSE.has(action) ? "closed" : "open";
}

function toJsonCase(record: ModerationCase): JsonCase {
  return {
    ...record,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function fromJsonCase(raw: JsonCase): ModerationCase {
  return {
    ...raw,
    expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : null,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
  };
}

function reviveCase(document: Record<string, unknown>): ModerationCase {
  const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
  return {
    ...(document as unknown as ModerationCase),
    expiresAt:
      document.expiresAt instanceof Date
        ? document.expiresAt
        : document.expiresAt
          ? new Date(String(document.expiresAt))
          : null,
    createdAt: date(document.createdAt),
    updatedAt: date(document.updatedAt),
    metadata: (document.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

/**
 * Per-guild moderation ledger. Mongo provides atomic sequence numbers; the
 * JSON fallback keeps cases durable when Mongo is absent or unreachable.
 */
export class CaseStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private collection: Collection<CaseDocument> | null = null;
  private counters: Collection<CounterDocument> | null = null;
  private indexesReady = false;
  private jsonMode = false;
  private warnedMongo = false;
  private warnedJson = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: CaseStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
  }

  public get durable(): boolean {
    return Boolean(this.database) && !this.jsonMode;
  }

  public create(input: NewCase): Promise<ModerationCase> {
    const run = this.queue.then(() => this.createNow(input));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async get(guildId: string, caseId: number): Promise<ModerationCase | null> {
    await this.queue;
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCases();
        const document = await collection.findOne({ _id: `${guildId}:${caseId}` });
        return document ? reviveCase(document) : null;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const record = all[guildId]?.cases.find((entry) => entry.caseId === caseId);
    return record ? fromJsonCase(record) : null;
  }

  public async list(guildId: string, filter: CaseFilter = {}): Promise<ModerationCase[]> {
    await this.queue;
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCases();
        const query: Filter<CaseDocument> = { guildId };
        if (filter.targetId) {
          query.targetId = filter.targetId;
        }
        if (filter.moderatorId) {
          query.moderatorId = filter.moderatorId;
        }
        if (filter.action) {
          query.action = filter.action;
        }
        if (filter.status) {
          query.status = filter.status;
        }
        if (filter.since) {
          query.createdAt = { $gte: filter.since };
        }
        const documents = await collection
          .find(query)
          .sort({ caseId: -1 })
          .limit(filter.limit ?? 100)
          .toArray();
        return documents.map(reviveCase);
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    return (all[guildId]?.cases ?? [])
      .map(fromJsonCase)
      .filter((record) => !filter.targetId || record.targetId === filter.targetId)
      .filter((record) => !filter.moderatorId || record.moderatorId === filter.moderatorId)
      .filter((record) => !filter.action || record.action === filter.action)
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.since || record.createdAt.getTime() >= filter.since.getTime())
      .sort((a, b) => b.caseId - a.caseId)
      .slice(0, filter.limit ?? 100);
  }

  public updateStatus(
    guildId: string,
    caseId: number,
    status: CaseStatus,
    actorId: string,
    note?: string,
  ): Promise<void> {
    const run = this.queue.then(() => this.updateStatusNow(guildId, caseId, status, actorId, note));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async countByModerator(
    guildId: string,
    moderatorId: string,
    since: Date,
  ): Promise<number> {
    await this.queue;
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCases();
        return await collection.countDocuments({
          guildId,
          moderatorId,
          createdAt: { $gte: since },
        });
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    return (all[guildId]?.cases ?? []).filter(
      (record) =>
        record.moderatorId === moderatorId &&
        new Date(record.createdAt).getTime() >= since.getTime(),
    ).length;
  }

  public markExpired(guildId: string, now: Date): Promise<number> {
    const run = this.queue.then(() => this.markExpiredNow(guildId, now));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private buildCase(input: NewCase, caseId: number): ModerationCase {
    const now = new Date();
    return {
      caseId,
      guildId: input.guildId,
      action: input.action,
      targetId: input.targetId ?? null,
      targetTag: input.targetTag ?? null,
      moderatorId: input.moderatorId,
      moderatorTag: input.moderatorTag ?? input.moderatorId,
      reason: input.reason ?? "",
      durationMs: input.durationMs ?? null,
      expiresAt: input.expiresAt ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      status: input.status ?? defaultStatus(input.action),
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  private async createNow(input: NewCase): Promise<ModerationCase> {
    if (!this.jsonMode && this.database) {
      let reserved: number | null = null;
      try {
        reserved = await this.reserveMongoId(input.guildId);
        const record = this.buildCase(input, reserved);
        const collection = await this.mongoCases();
        await collection.insertOne({ _id: `${record.guildId}:${record.caseId}`, ...record });
        return record;
      } catch (error) {
        this.failMongo(error);
        return this.createJson(input, reserved);
      }
    }
    return this.createJson(input, null);
  }

  private async createJson(input: NewCase, reserved: number | null): Promise<ModerationCase> {
    const all = await this.readJson();
    const state = all[input.guildId] ?? { nextCaseId: 1, cases: [] };
    const highest = state.cases.reduce((max, entry) => Math.max(max, entry.caseId), 0);
    const caseId = Math.max(state.nextCaseId, highest + 1, reserved ?? 1);
    const record = this.buildCase(input, caseId);
    state.nextCaseId = caseId + 1;
    state.cases.push(toJsonCase(record));
    all[input.guildId] = state;
    await this.writeJson(all);
    return record;
  }

  private async updateStatusNow(
    guildId: string,
    caseId: number,
    status: CaseStatus,
    actorId: string,
    note: string | undefined,
  ): Promise<void> {
    const now = new Date();
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCases();
        await collection.updateOne(
          { _id: `${guildId}:${caseId}` },
          {
            $set: {
              status,
              updatedAt: now,
              "metadata.statusActorId": actorId,
              "metadata.statusChangedAt": now.toISOString(),
              ...(note ? { "metadata.statusNote": note } : {}),
            },
          },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const state = all[guildId];
    const record = state?.cases.find((entry) => entry.caseId === caseId);
    if (!state || !record) {
      return;
    }
    record.status = status;
    record.updatedAt = now.toISOString();
    record.metadata = {
      ...record.metadata,
      statusActorId: actorId,
      statusChangedAt: now.toISOString(),
      ...(note ? { statusNote: note } : {}),
    };
    await this.writeJson(all);
  }

  private async markExpiredNow(guildId: string, now: Date): Promise<number> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCases();
        const result = await collection.updateMany(
          {
            guildId,
            status: "open",
            expiresAt: { $ne: null, $lte: now },
          },
          { $set: { status: "expired", updatedAt: now } },
        );
        return result.modifiedCount;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const state = all[guildId];
    if (!state) {
      return 0;
    }
    let expired = 0;
    for (const record of state.cases) {
      if (
        record.status === "open" &&
        record.expiresAt !== null &&
        new Date(record.expiresAt).getTime() <= now.getTime()
      ) {
        record.status = "expired";
        record.updatedAt = now.toISOString();
        expired += 1;
      }
    }
    if (expired > 0) {
      await this.writeJson(all);
    }
    return expired;
  }

  private async reserveMongoId(guildId: string): Promise<number> {
    await this.mongoCases();
    const counters = await this.mongoCounters();
    const document = await counters.findOneAndUpdate(
      { _id: `mod_cases:${guildId}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    if (!document || typeof document.seq !== "number") {
      throw new Error("Moderation case counter did not return a sequence");
    }
    return document.seq;
  }

  private async mongoCases(): Promise<Collection<CaseDocument>> {
    if (this.collection && this.indexesReady) {
      return this.collection;
    }
    const collection = await this.database!.collection<CaseDocument>(CASES);
    if (!this.indexesReady) {
      await collection.createIndex({ guildId: 1, caseId: 1 }, { unique: true });
      await collection.createIndex({ guildId: 1, targetId: 1, caseId: -1 });
      await collection.createIndex({ guildId: 1, moderatorId: 1, createdAt: -1 });
      this.indexesReady = true;
    }
    this.collection = collection;
    return collection;
  }

  private async mongoCounters(): Promise<Collection<CounterDocument>> {
    if (this.counters) {
      return this.counters;
    }
    const counters = await this.database!.collection<CounterDocument>(COUNTERS);
    this.counters = counters;
    return counters;
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
      this.warnJson("Could not read moderation cases; starting a new file", error);
      return {};
    }
  }

  private async writeJson(all: JsonDocument): Promise<void> {
    await mkdir(dirname(this.jsonPath), { recursive: true });
    const temp = `${this.jsonPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.jsonPath);
  }

  private failMongo(error: unknown): void {
    this.jsonMode = true;
    if (!this.warnedMongo) {
      this.warnedMongo = true;
      this.logger.warn(
        "Moderation case Mongo store unavailable; falling back to JSON",
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
