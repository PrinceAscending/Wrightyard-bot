import {
  ChannelType,
  OverwriteType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Role,
} from "discord.js";
import type { AuditService } from "../audit/service.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import type {
  ChannelSnapshot,
  GuildSnapshot,
  RoleSnapshot,
  SnapshotStore,
} from "./snapshot.js";
import type { ObservedAction } from "./types.js";

export interface RestoreItem {
  readonly kind: "role" | "category" | "channel" | "thread";
  readonly id: string;
  readonly position: number;
  readonly payload?: unknown;
}

export interface OverwritePlan {
  readonly id: string;
  readonly type: "role" | "member";
  readonly allow: bigint;
  readonly deny: bigint;
}

export interface RestoreResult {
  readonly kind: "role" | "channel";
  readonly restoredId: string | null;
  readonly note: string;
}

export interface RestoreServiceOptions {
  readonly client: Client;
  readonly config: Config;
  readonly snapshotStore: SnapshotStore;
  readonly audit: AuditService;
  readonly logger: Logger;
}

interface RestorableRole {
  readonly id: string;
  readonly name: string;
  readonly color?: number;
  readonly hoist?: boolean;
  readonly mentionable?: boolean;
  readonly position?: number;
  readonly managed?: boolean;
  readonly permissions?: string | { readonly bitfield: bigint };
}

interface RawOverwrite {
  readonly id: string;
  readonly type?: number | string;
  readonly allow: string | bigint;
  readonly deny: string | bigint;
}

interface RestorableChannel {
  readonly id: string;
  readonly name?: string | null;
  readonly type: number;
  readonly parentId?: string | null;
  readonly position?: number | null;
  readonly topic?: string | null;
  readonly nsfw?: boolean | null;
  readonly rateLimitPerUser?: number | null;
  readonly bitrate?: number | null;
  readonly userLimit?: number | null;
  readonly overwrites?: readonly RawOverwrite[];
  readonly permissionOverwrites?: {
    readonly cache: {
      values(): IterableIterator<{
        readonly id: string;
        readonly type?: number;
        readonly allow: bigint;
        readonly deny: bigint;
      }>;
    };
  };
}

const KIND_ORDER: Record<RestoreItem["kind"], number> = {
  role: 0,
  category: 1,
  channel: 2,
  thread: 3,
};

const THREAD_TYPES = new Set<number>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

const TEXT_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);

const VOICE_TYPES = new Set<number>([
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

/**
 * Roles must exist before channel overwrites can reference them, and categories
 * before their children, so this order is required for a clean restore.
 */
export function planRestoreOrder(items: readonly RestoreItem[]): RestoreItem[] {
  return [...items].sort((left, right) => {
    const rank = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    return rank !== 0 ? rank : left.position - right.position;
  });
}

export function remapOverwrites(
  overwrites: readonly OverwritePlan[],
  roleMap: ReadonlyMap<string, string>,
): OverwritePlan[] {
  return overwrites.map((overwrite) => {
    if (overwrite.type !== "role") {
      return overwrite;
    }
    const mapped = roleMap.get(overwrite.id);
    return mapped ? { ...overwrite, id: mapped } : overwrite;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRole(value: unknown): RestorableRole | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  return value as unknown as RestorableRole;
}

function asChannel(value: unknown): RestorableChannel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "number") {
    return null;
  }
  return value as unknown as RestorableChannel;
}

function rolePermissions(role: RestorableRole): string {
  if (typeof role.permissions === "string") {
    return role.permissions;
  }
  return role.permissions?.bitfield.toString() ?? "0";
}

function roleColor(role: RestorableRole): number {
  return typeof role.color === "number" ? role.color : 0;
}

function rawOverwrites(channel: RestorableChannel): RawOverwrite[] {
  if (channel.overwrites) {
    return [...channel.overwrites];
  }
  if (!channel.permissionOverwrites) {
    return [];
  }
  return [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type ?? OverwriteType.Role,
    allow: overwrite.allow,
    deny: overwrite.deny,
  }));
}

function toOverwritePlans(channel: RestorableChannel): OverwritePlan[] {
  return rawOverwrites(channel).map((overwrite) => ({
    id: overwrite.id,
    type:
      overwrite.type === "member" || overwrite.type === OverwriteType.Member
        ? "member"
        : "role",
    allow: typeof overwrite.allow === "bigint" ? overwrite.allow : BigInt(overwrite.allow),
    deny: typeof overwrite.deny === "bigint" ? overwrite.deny : BigInt(overwrite.deny),
  }));
}

/**
 * Restores deleted guild structure from the gateway payload, falling back to
 * the latest snapshot only for parent and position context. All operations run
 * through one promise chain so two incidents cannot interleave ID maps.
 */
export class RestoreService {
  private readonly client: Client;
  private readonly config: Config;
  private readonly snapshotStore: SnapshotStore;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly roleMap = new Map<string, string>();
  private readonly channelMap = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();

  public constructor(options: RestoreServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.snapshotStore = options.snapshotStore;
    this.audit = options.audit;
    this.logger = options.logger;
  }

  public restoreRole(role: RestorableRole, reason: string): Promise<RestoreResult> {
    return this.enqueue(() => this.restoreRoleNow(role, reason));
  }

  public restoreChannel(
    channel: RestorableChannel,
    reason: string,
  ): Promise<RestoreResult> {
    return this.enqueue(() => this.restoreChannelNow(channel, reason));
  }

  public restoreIncident(
    actions: readonly ObservedAction[],
    reason: string,
  ): Promise<RestoreResult[]> {
    return this.enqueue(async () => {
      this.roleMap.clear();
      this.channelMap.clear();
      const results: RestoreResult[] = [];
      let failed = 0;

      try {
        const items = this.restoreItems(actions);
        const snapshot = items.some((item) => item.kind !== "role")
          ? await this.loadSnapshot()
          : null;

        for (const item of planRestoreOrder(items)) {
          try {
            if (item.kind === "role") {
              const role = asRole(item.payload);
              results.push(
                role
                  ? await this.restoreRoleNow(role, reason)
                  : { kind: "role", restoredId: null, note: "Role payload was unreadable." },
              );
              continue;
            }
            const channel = asChannel(item.payload);
            results.push(
              channel
                ? await this.restoreChannelNow(channel, reason, snapshot)
                : {
                    kind: "channel",
                    restoredId: null,
                    note: "Channel payload was unreadable.",
                  },
            );
          } catch (error) {
            failed += 1;
            this.logger.warn("Security restore item failed", {
              kind: item.kind,
              id: item.id,
              error: serializeError(error),
            });
            results.push({
              kind: item.kind === "role" ? "role" : "channel",
              restoredId: null,
              note: "Restore failed; see logs.",
            });
          }
        }
      } catch (error) {
        failed += 1;
        this.logger.warn("Security restore failed", serializeError(error));
      }

      const restored = results.filter((result) => result.restoredId !== null).length;
      try {
        this.audit.record({
          category: "security",
          type: "security.restore",
          summary: "Incident restore complete",
          severity: failed > 0 ? "warn" : "info",
          fields: [
            { name: "Restored", value: String(restored), inline: true },
            { name: "Failed", value: String(failed), inline: true },
            { name: "Reason", value: reason },
          ],
          payload: { restored, failed, reason },
          feed: false,
        });
      } catch (error) {
        this.logger.warn("Could not record the restore summary", serializeError(error));
      }

      return results;
    });
  }

  private async restoreRoleNow(
    role: RestorableRole,
    reason: string,
  ): Promise<RestoreResult> {
    const guild = this.guild();
    if (!guild) {
      return { kind: "role", restoredId: null, note: "Guild is not available." };
    }

    if (role.managed) {
      const note = "Managed roles cannot be recreated.";
      this.recordRestore("role", role.id, role.name, null, note);
      return { kind: "role", restoredId: null, note };
    }

    const name = this.uniqueRoleName(guild, role.name);
    const created = await guild.roles.create({
      name,
      colors: { primaryColor: roleColor(role) },
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      permissions: BigInt(rolePermissions(role)),
      reason,
    });

    const highest = guild.members.me?.roles?.highest?.position ?? 0;
    const position = Math.max(0, Math.min(role.position ?? 0, Math.max(0, highest - 1)));
    try {
      await created.setPosition(position);
    } catch (error) {
      this.logger.warn("Could not set the restored role position", {
        roleId: created.id,
        error: serializeError(error),
      });
    }

    this.roleMap.set(role.id, created.id);
    const note = `Restored role ${name}.`;
    this.recordRestore("role", role.id, role.name, created.id, note);
    return { kind: "role", restoredId: created.id, note };
  }

  private async restoreChannelNow(
    channel: RestorableChannel,
    reason: string,
    loadedSnapshot?: GuildSnapshot | null,
  ): Promise<RestoreResult> {
    const guild = this.guild();
    if (!guild) {
      return { kind: "channel", restoredId: null, note: "Guild is not available." };
    }

    if (THREAD_TYPES.has(channel.type)) {
      const note =
        "Threads cannot be recreated without their parent message; restore the parent channel first.";
      this.recordRestore("channel", channel.id, channel.name ?? channel.id, null, note);
      return { kind: "channel", restoredId: null, note };
    }

    const supported =
      channel.type === ChannelType.GuildCategory ||
      TEXT_TYPES.has(channel.type) ||
      VOICE_TYPES.has(channel.type) ||
      channel.type === ChannelType.GuildForum;
    if (!supported) {
      const note = "Unsupported channel type; restore manually.";
      this.recordRestore("channel", channel.id, channel.name ?? channel.id, null, note);
      return { kind: "channel", restoredId: null, note };
    }

    const snapshot = loadedSnapshot === undefined ? await this.loadSnapshot() : loadedSnapshot;
    const snapshotChannel = snapshot?.channels.find((entry) => entry.id === channel.id) ?? null;
    const parentResult = this.resolveParent(guild, channel, snapshot, snapshotChannel);
    const name = this.uniqueChannelName(guild, channel.name ?? snapshotChannel?.name ?? channel.id);
    const position = channel.position ?? snapshotChannel?.position ?? 0;
    const permissionOverwrites = remapOverwrites(
      toOverwritePlans(channel),
      this.roleMap,
    ).map((overwrite) => ({
      id: overwrite.id,
      type:
        overwrite.type === "role" ? OverwriteType.Role : OverwriteType.Member,
      allow: overwrite.allow,
      deny: overwrite.deny,
    }));

    const base = {
      name,
      ...(parentResult.parentId ? { parent: parentResult.parentId } : {}),
      permissionOverwrites,
      reason,
    };

    let created: GuildBasedChannel;
    if (channel.type === ChannelType.GuildCategory) {
      created = await guild.channels.create({
        ...base,
        type: ChannelType.GuildCategory,
      });
    } else if (TEXT_TYPES.has(channel.type)) {
      created = await guild.channels.create({
        ...base,
        type:
          channel.type === ChannelType.GuildAnnouncement
            ? ChannelType.GuildAnnouncement
            : ChannelType.GuildText,
        topic: channel.topic ?? undefined,
        nsfw: channel.nsfw ?? false,
        rateLimitPerUser: channel.rateLimitPerUser ?? 0,
      });
    } else if (channel.type === ChannelType.GuildForum) {
      created = await guild.channels.create({
        ...base,
        type: ChannelType.GuildForum,
        topic: channel.topic ?? undefined,
        nsfw: channel.nsfw ?? false,
        rateLimitPerUser: channel.rateLimitPerUser ?? 0,
      });
    } else if (channel.type === ChannelType.GuildStageVoice) {
      created = await guild.channels.create({
        ...base,
        type: ChannelType.GuildStageVoice,
        bitrate: channel.bitrate ?? undefined,
        userLimit: channel.userLimit ?? undefined,
      });
    } else {
      created = await guild.channels.create({
        ...base,
        type: ChannelType.GuildVoice,
        bitrate: channel.bitrate ?? undefined,
        userLimit: channel.userLimit ?? undefined,
      });
    }

    try {
      await created.setPosition(Math.max(0, position));
    } catch (error) {
      this.logger.warn("Could not set the restored channel position", {
        channelId: created.id,
        error: serializeError(error),
      });
    }

    this.channelMap.set(channel.id, created.id);
    const note = [
      `Restored channel ${name}.`,
      "Message history cannot be restored.",
      ...parentResult.notes,
    ].join(" ");
    this.recordRestore("channel", channel.id, channel.name ?? channel.id, created.id, note);
    return { kind: "channel", restoredId: created.id, note };
  }

  private restoreItems(actions: readonly ObservedAction[]): RestoreItem[] {
    const items: RestoreItem[] = [];
    for (const action of actions) {
      if (action.kind === "roleDelete") {
        const role = asRole(action.payload);
        if (role) {
          items.push({
            kind: "role",
            id: role.id,
            position: role.position ?? 0,
            payload: role,
          });
        }
        continue;
      }

      if (action.kind === "channelDelete" || action.kind === "threadDelete") {
        const channel = asChannel(action.payload);
        if (!channel) {
          continue;
        }
        items.push({
          kind:
            action.kind === "threadDelete"
              ? "thread"
              : channel.type === ChannelType.GuildCategory
                ? "category"
                : "channel",
          id: channel.id,
          position: channel.position ?? 0,
          payload: channel,
        });
      }
    }
    return items;
  }

  private resolveParent(
    guild: Guild,
    channel: RestorableChannel,
    snapshot: GuildSnapshot | null,
    snapshotChannel: ChannelSnapshot | null,
  ): { parentId: string | null; notes: string[] } {
    const raw = channel.parentId ?? snapshotChannel?.parentId ?? null;
    if (!raw) {
      return { parentId: null, notes: [] };
    }

    const fromIncident = this.channelMap.get(raw);
    if (fromIncident) {
      return { parentId: fromIncident, notes: [] };
    }
    if (guild.channels.cache.has(raw)) {
      return { parentId: raw, notes: [] };
    }

    const snapshotParent = snapshot?.channels.find((entry) => entry.id === raw) ?? null;
    if (snapshotParent) {
      const byName = guild.channels.cache.find(
        (entry) =>
          entry.type === ChannelType.GuildCategory && entry.name === snapshotParent.name,
      );
      if (byName) {
        return { parentId: byName.id, notes: [] };
      }
    }

    return {
      parentId: null,
      notes: ["Parent category could not be found; restored at the guild root."],
    };
  }

  private uniqueRoleName(guild: Guild, name: string): string {
    const names = new Set([...guild.roles.cache.values()].map((role) => role.name));
    return uniqueName(name, (candidate) => names.has(candidate));
  }

  private uniqueChannelName(guild: Guild, name: string): string {
    const names = new Set([...guild.channels.cache.values()].map((channel) => channel.name));
    return uniqueName(name, (candidate) => names.has(candidate));
  }

  private recordRestore(
    kind: "role" | "channel",
    oldId: string,
    name: string,
    newId: string | null,
    note: string,
  ): void {
    try {
      this.audit.record({
        category: "security",
        type: "security.restore",
        summary: newId ? `Restored ${kind} ${name}` : `Could not restore ${kind} ${name}`,
        severity: newId ? "info" : "warn",
        target: { id: oldId, name },
        fields: [
          { name: "Type", value: kind, inline: true },
          { name: "Old ID", value: oldId, inline: true },
          { name: "New ID", value: newId ?? "none", inline: true },
          { name: "Note", value: note },
        ],
        payload: { oldId, newId, kind, note },
      });
    } catch (error) {
      this.logger.warn("Could not record the security restore", serializeError(error));
    }
  }

  private async loadSnapshot(): Promise<GuildSnapshot | null> {
    const guild = this.guild();
    if (!guild) {
      return null;
    }
    try {
      return await this.snapshotStore.load(guild.id);
    } catch (error) {
      this.logger.warn("Could not load the guild snapshot", serializeError(error));
      return null;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private guild(): Guild | null {
    return this.client.guilds.cache.get(this.config.guildId) ?? null;
  }
}

function uniqueName(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) {
    return base;
  }
  let candidate = `${base}-restored`;
  let index = 2;
  while (taken(candidate)) {
    candidate = `${base}-restored-${index}`;
    index += 1;
  }
  return candidate;
}

export type { ChannelSnapshot, GuildSnapshot, RoleSnapshot };
