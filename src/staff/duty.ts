import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection } from "mongodb";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";

export interface DutySession {
  readonly id: string;
  readonly guildId: string;
  readonly moderatorId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

interface DutyDocument extends Record<string, unknown> {
  _id: string;
  guildId: string;
  moderatorId: string;
  startedAt: Date;
  endedAt: Date | null;
}

interface JsonSession {
  id: string;
  guildId: string;
  moderatorId: string;
  startedAt: string;
  endedAt: string | null;
}

interface GuildDuty {
  sessions: JsonSession[];
}

type JsonDocument = Record<string, GuildDuty>;

export interface DutyStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
}

const COLLECTION = "staff_duty";

function revive(document: DutyDocument): DutySession {
  return {
    id: document._id,
    guildId: document.guildId,
    moderatorId: document.moderatorId,
    startedAt: document.startedAt instanceof Date ? document.startedAt : new Date(String(document.startedAt)),
    endedAt:
      document.endedAt instanceof Date
        ? document.endedAt
        : document.endedAt
          ? new Date(String(document.endedAt))
          : null,
  };
}

function fromJson(raw: JsonSession): DutySession {
  return {
    ...raw,
    startedAt: new Date(raw.startedAt),
    endedAt: raw.endedAt ? new Date(raw.endedAt) : null,
  };
}

function toJson(session: DutySession): JsonSession {
  return {
    ...session,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
  };
}

export class DutyStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private collection: Collection<DutyDocument> | null = null;
  private jsonMode = false;
  private warnedMongo = false;
  private warnedJson = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: DutyStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
  }

  public start(
    guildId: string,
    moderatorId: string,
    at: Date = new Date(),
  ): Promise<DutySession> {
    const run = this.queue.then(async () => {
      const existing = await this.findActive(guildId, moderatorId);
      if (existing) {
        return existing;
      }
      return this.startNow(guildId, moderatorId, at);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async stop(
    guildId: string,
    moderatorId: string,
    at: Date = new Date(),
  ): Promise<DutySession | null> {
    await this.queue;
    const run = this.queue.then(() => this.stopNow(guildId, moderatorId, at));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async activeSession(
    guildId: string,
    moderatorId: string,
  ): Promise<DutySession | null> {
    await this.queue;
    return this.findActive(guildId, moderatorId);
  }

  private async findActive(
    guildId: string,
    moderatorId: string,
  ): Promise<DutySession | null> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const document = await collection.findOne(
          { guildId, moderatorId, endedAt: null },
          { sort: { startedAt: -1 } },
        );
        return document ? revive(document) : null;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const sessions = (all[guildId]?.sessions ?? [])
      .map(fromJson)
      .filter((session) => session.moderatorId === moderatorId && session.endedAt === null)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return sessions[0] ?? null;
  }

  public async minutesSince(
    guildId: string,
    moderatorId: string,
    since: Date,
  ): Promise<number> {
    await this.queue;
    const now = new Date();
    let sessions: DutySession[] = [];
    let loaded = false;
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const documents = await collection
          .find({ guildId, moderatorId })
          .toArray();
        sessions = documents.map(revive);
        loaded = true;
      } catch (error) {
        this.failMongo(error);
      }
    }
    if (!loaded) {
      const all = await this.readJson();
      sessions = (all[guildId]?.sessions ?? [])
        .map(fromJson)
        .filter((session) => session.moderatorId === moderatorId);
    }

    let totalMs = 0;
    for (const session of sessions) {
      const start = Math.max(session.startedAt.getTime(), since.getTime());
      const end = Math.min((session.endedAt ?? now).getTime(), now.getTime());
      if (end > start) {
        totalMs += end - start;
      }
    }
    return Math.floor(totalMs / 60_000);
  }

  public async closeStaleSessions(
    guildId: string,
    at: Date = new Date(),
  ): Promise<number> {
    await this.queue;
    const run = this.queue.then(() => this.closeStaleNow(guildId, at));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private async startNow(
    guildId: string,
    moderatorId: string,
    at: Date,
  ): Promise<DutySession> {
    const session: DutySession = {
      id: randomUUID(),
      guildId,
      moderatorId,
      startedAt: at,
      endedAt: null,
    };
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.insertOne({
          _id: session.id,
          guildId,
          moderatorId,
          startedAt: at,
          endedAt: null,
        });
        return session;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const state = all[guildId] ?? { sessions: [] };
    state.sessions.push(toJson(session));
    all[guildId] = state;
    await this.writeJson(all);
    return session;
  }

  private async stopNow(
    guildId: string,
    moderatorId: string,
    at: Date,
  ): Promise<DutySession | null> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const document = await collection.findOneAndUpdate(
          { guildId, moderatorId, endedAt: null },
          { $set: { endedAt: at } },
          { sort: { startedAt: -1 }, returnDocument: "after" },
        );
        return document ? revive(document) : null;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const sessions = all[guildId]?.sessions ?? [];
    const open = sessions
      .filter((session) => session.moderatorId === moderatorId && session.endedAt === null)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
    if (!open) {
      return null;
    }
    open.endedAt = at.toISOString();
    await this.writeJson(all);
    return fromJson(open);
  }

  private async closeStaleNow(guildId: string, at: Date): Promise<number> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const result = await collection.updateMany(
          { guildId, endedAt: null },
          { $set: { endedAt: at } },
        );
        return result.modifiedCount;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const sessions = all[guildId]?.sessions ?? [];
    let closed = 0;
    for (const session of sessions) {
      if (session.endedAt === null) {
        session.endedAt = at.toISOString();
        closed += 1;
      }
    }
    if (closed > 0) {
      await this.writeJson(all);
    }
    return closed;
  }

  private async mongoCollection(): Promise<Collection<DutyDocument>> {
    if (this.collection) {
      return this.collection;
    }
    const collection = await this.database!.collection<DutyDocument>(COLLECTION);
    await collection.createIndex({ guildId: 1, moderatorId: 1, endedAt: 1 });
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
      this.warnJson("Could not read duty sessions; starting a new file", error);
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
        "Duty Mongo store unavailable; falling back to JSON",
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
