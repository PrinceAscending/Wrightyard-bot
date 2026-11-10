import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";

export interface AuditCursorStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
}

interface CursorDocument {
  readonly _id: string;
  readonly entryId: string;
  readonly updatedAt: Date;
}

const COLLECTION = "audit_cursors";

export class AuditCursorStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private readonly cache = new Map<string, string>();
  private jsonMode = false;
  private warned = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: AuditCursorStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
  }

  public async get(type: string): Promise<string | null> {
    if (this.cache.has(type)) {
      return this.cache.get(type) ?? null;
    }
    await this.queue;

    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.database.collection<CursorDocument>(COLLECTION);
        const document = await collection.findOne({ _id: type });
        if (document?.entryId) {
          this.cache.set(type, document.entryId);
          return document.entryId;
        }
        return null;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const entryId = all[type] ?? null;
    if (entryId) {
      this.cache.set(type, entryId);
    }
    return entryId;
  }

  public set(type: string, entryId: string): Promise<void> {
    this.cache.set(type, entryId);
    const run = this.queue.then(() => this.write(type, entryId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  public async close(): Promise<void> {
    await this.queue;
  }

  private async write(type: string, entryId: string): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.database.collection<CursorDocument>(COLLECTION);
        await collection.updateOne(
          { _id: type },
          { $set: { entryId, updatedAt: new Date() } },
          { upsert: true },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }
    const all = await this.readJson();
    all[type] = entryId;
    await this.writeJson(all);
  }

  private async readJson(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return {};
      }
      this.warnOnce("Could not read audit cursor file", error);
      return {};
    }
  }

  private async writeJson(all: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.jsonPath), { recursive: true });
    const temp = `${this.jsonPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.jsonPath);
  }

  private failMongo(error: unknown): void {
    this.jsonMode = true;
    this.warnOnce("Audit cursor Mongo store unavailable; falling back to JSON", error);
  }

  private warnOnce(message: string, error: unknown): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    this.logger.warn(message, serializeError(error));
  }
}
