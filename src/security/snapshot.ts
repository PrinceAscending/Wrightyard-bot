import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Collection } from "mongodb";
import type { Guild } from "discord.js";
import type { BotDatabase } from "../db.js";
import { serializeError, type Logger } from "../logger.js";

export interface RoleSnapshot {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  readonly permissions: string;
  readonly position: number;
  readonly managed: boolean;
}

export interface OverwriteSnapshot {
  readonly id: string;
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export interface ChannelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly position: number;
  readonly topic: string | null;
  readonly nsfw: boolean;
  readonly rateLimitPerUser: number;
  readonly bitrate: number | null;
  readonly userLimit: number | null;
  readonly overwrites: readonly OverwriteSnapshot[];
}

export interface GuildSnapshot {
  readonly guildId: string;
  readonly capturedAt: Date;
  readonly roles: readonly RoleSnapshot[];
  readonly channels: readonly ChannelSnapshot[];
  readonly version: 1;
}

interface SnapshotDocument extends Record<string, unknown> {
  _id: string;
}

interface JsonSnapshot {
  capturedAt: string;
  roles: RoleSnapshot[];
  channels: ChannelSnapshot[];
  version: 1;
}

type JsonDocument = Record<string, JsonSnapshot>;

export interface SnapshotStoreOptions {
  readonly database: BotDatabase | null;
  readonly jsonPath: string;
  readonly logger: Logger;
}

const COLLECTION = "guild_snapshots";

interface ChannelLike {
  readonly id: string;
  readonly name?: string | null;
  readonly type?: number;
  readonly parentId?: string | null;
  readonly position?: number | null;
  readonly topic?: string | null;
  readonly nsfw?: boolean | null;
  readonly rateLimitPerUser?: number | null;
  readonly bitrate?: number | null;
  readonly userLimit?: number | null;
  readonly permissionOverwrites?: {
    readonly cache?: {
      values(): IterableIterator<{
        readonly id: string;
        readonly type: number;
        readonly allow: { readonly bitfield: bigint };
        readonly deny: { readonly bitfield: bigint };
      }>;
    };
  };
}

function toJson(snapshot: GuildSnapshot): JsonSnapshot {
  return {
    ...snapshot,
    capturedAt: snapshot.capturedAt.toISOString(),
    roles: [...snapshot.roles],
    channels: [...snapshot.channels],
  };
}

function fromJson(guildId: string, raw: JsonSnapshot): GuildSnapshot {
  return {
    guildId,
    capturedAt: new Date(raw.capturedAt),
    roles: raw.roles,
    channels: raw.channels,
    version: 1,
  };
}

function revive(document: SnapshotDocument): GuildSnapshot {
  const capturedAt =
    document.capturedAt instanceof Date
      ? document.capturedAt
      : new Date(String(document.capturedAt));
  return {
    guildId: document._id,
    capturedAt,
    roles: (document.roles as RoleSnapshot[]) ?? [],
    channels: (document.channels as ChannelSnapshot[]) ?? [],
    version: 1,
  };
}

/**
 * Captures the restorable shape of a guild: roles without `@everyone`, then
 * every channel with its permission overwrites. Managed roles stay in the
 * snapshot so overwrite remapping still sees their IDs, but restore skips them.
 */
export function captureSnapshot(guild: Guild): GuildSnapshot {
  const everyoneId = guild.roles.everyone?.id ?? guild.id;
  const roles: RoleSnapshot[] = [];
  for (const role of guild.roles.cache.values()) {
    if (role.id === everyoneId || role.name === "@everyone") {
      continue;
    }
    roles.push({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
      managed: role.managed,
    });
  }

  const channels: ChannelSnapshot[] = [];
  for (const channel of guild.channels.cache.values()) {
    const value = channel as unknown as ChannelLike;
    const overwrites: OverwriteSnapshot[] = [];
    for (const overwrite of value.permissionOverwrites?.cache?.values() ?? []) {
      overwrites.push({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      });
    }
    channels.push({
      id: value.id,
      name: value.name ?? "",
      type: value.type ?? 0,
      parentId: value.parentId ?? null,
      position: value.position ?? 0,
      topic: value.topic ?? null,
      nsfw: value.nsfw ?? false,
      rateLimitPerUser: value.rateLimitPerUser ?? 0,
      bitrate: value.bitrate ?? null,
      userLimit: value.userLimit ?? null,
      overwrites,
    });
  }

  return {
    guildId: guild.id,
    capturedAt: new Date(),
    roles,
    channels,
    version: 1,
  };
}

export class SnapshotStore {
  private readonly database: BotDatabase | null;
  private readonly jsonPath: string;
  private readonly logger: Logger;
  private collection: Collection<SnapshotDocument> | null = null;
  private jsonMode = false;
  private warnedMongo = false;
  private warnedJson = false;

  public constructor(options: SnapshotStoreOptions) {
    this.database = options.database;
    this.jsonPath = options.jsonPath;
    this.logger = options.logger;
  }

  public async save(snapshot: GuildSnapshot): Promise<void> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        await collection.replaceOne(
          { _id: snapshot.guildId },
          {
            _id: snapshot.guildId,
            capturedAt: snapshot.capturedAt,
            roles: [...snapshot.roles],
            channels: [...snapshot.channels],
            version: 1,
          },
          { upsert: true },
        );
        return;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    all[snapshot.guildId] = toJson(snapshot);
    await this.writeJson(all);
  }

  public async load(guildId: string): Promise<GuildSnapshot | null> {
    if (!this.jsonMode && this.database) {
      try {
        const collection = await this.mongoCollection();
        const document = await collection.findOne({ _id: guildId });
        return document ? revive(document) : null;
      } catch (error) {
        this.failMongo(error);
      }
    }

    const all = await this.readJson();
    const raw = all[guildId];
    return raw ? fromJson(guildId, raw) : null;
  }

  public async close(): Promise<void> {
    return undefined;
  }

  private async mongoCollection(): Promise<Collection<SnapshotDocument>> {
    if (this.collection) {
      return this.collection;
    }
    const collection = await this.database!.collection<SnapshotDocument>(COLLECTION);
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
      this.warnJson("Could not read the guild snapshot; starting a new file", error);
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
        "Snapshot Mongo store unavailable; falling back to JSON",
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
