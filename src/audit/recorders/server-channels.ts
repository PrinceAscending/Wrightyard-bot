import {
  AuditLogEvent,
  ChannelType,
  Events,
  type Client,
} from "discord.js";
import type { Config } from "../../config.js";
import { serializeError, type Logger } from "../../logger.js";
import type { SecurityObserver } from "../../security/types.js";
import { AuditLogResolver, attributionFailureEvent } from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditActor, AuditEventInput, AuditField } from "../types.js";

export interface OverwriteLike {
  readonly id: string;
  readonly type?: number;
  readonly allow: bigint;
  readonly deny: bigint;
}

export interface ChannelLike {
  readonly id: string;
  readonly name?: string;
  readonly type: number;
  readonly parentId?: string | null;
  readonly position?: number;
  readonly topic?: string | null;
  readonly nsfw?: boolean;
  readonly rateLimitPerUser?: number;
  readonly bitrate?: number;
  readonly userLimit?: number;
  readonly permissionOverwrites?: { readonly cache: { values(): IterableIterator<OverwriteLike> } };
}

export interface ThreadLike extends ChannelLike {
  readonly archived?: boolean;
  readonly locked?: boolean;
}

function channelName(channel: ChannelLike): string {
  return channel.name ?? channel.id;
}

function typeName(type: number): string {
  return ChannelType[type] ?? String(type);
}

function overwritesOf(channel: ChannelLike): OverwriteLike[] {
  return channel.permissionOverwrites ? [...channel.permissionOverwrites.cache.values()] : [];
}

function overwriteKey(overwrite: OverwriteLike): string {
  return `${overwrite.allow}:${overwrite.deny}`;
}

function channelFields(channel: ChannelLike): AuditField[] {
  return [
    { name: "Name", value: channelName(channel), inline: true },
    { name: "Type", value: typeName(channel.type), inline: true },
    { name: "Parent", value: channel.parentId ? `<#${channel.parentId}>` : "none", inline: true },
    { name: "Position", value: String(channel.position ?? 0), inline: true },
    { name: "Topic", value: channel.topic ?? "none" },
    { name: "NSFW", value: channel.nsfw ? "yes" : "no", inline: true },
    { name: "Slowmode", value: `${channel.rateLimitPerUser ?? 0}s`, inline: true },
  ];
}

function restorePayload(channel: ChannelLike): Record<string, unknown> {
  return {
    name: channelName(channel),
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    overwrites: overwritesOf(channel).map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type ?? 0,
      allow: overwrite.allow.toString(),
      deny: overwrite.deny.toString(),
    })),
  };
}

export function channelCreateEvent(
  channel: ChannelLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "channel.create",
    summary: `Channel ${channelName(channel)} created`,
    ...(actor ? { actor } : {}),
    target: { id: channel.id, name: channelName(channel) },
    channelId: channel.id,
    fields: channelFields(channel),
    payload: { guildId },
  };
}

export function channelDeleteEvent(
  channel: ChannelLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "channel.delete",
    summary: `Channel ${channelName(channel)} deleted`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: channel.id, name: channelName(channel) },
    channelId: channel.id,
    fields: channelFields(channel),
    payload: { guildId, ...restorePayload(channel) },
  };
}

function renderOverwrites(overwrites: readonly OverwriteLike[]): string {
  return overwrites.length > 0
    ? overwrites
        .map(
          (overwrite) =>
            `<@${overwrite.id}> allow ${overwrite.allow.toString()} deny ${overwrite.deny.toString()}`,
        )
        .join("\n")
    : "none";
}

export function channelUpdateEvents(
  before: ChannelLike,
  after: ChannelLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput[] {
  const events: AuditEventInput[] = [];
  const changes: string[] = [];
  const properties: [string, unknown, unknown][] = [
    ["name", before.name, after.name],
    ["type", before.type, after.type],
    ["parent", before.parentId, after.parentId],
    ["position", before.position, after.position],
    ["topic", before.topic, after.topic],
    ["nsfw", before.nsfw, after.nsfw],
    ["slowmode", before.rateLimitPerUser, after.rateLimitPerUser],
    ["bitrate", before.bitrate, after.bitrate],
    ["user limit", before.userLimit, after.userLimit],
  ];
  for (const [label, previous, next] of properties) {
    if (previous !== next) {
      changes.push(`${label}: ${String(previous ?? "none")} → ${String(next ?? "none")}`);
    }
  }

  if (changes.length > 0) {
    events.push({
      category: "server",
      type: "channel.update",
      summary: `Channel ${channelName(after)} updated`,
      ...(actor ? { actor } : {}),
      target: { id: after.id, name: channelName(after) },
      channelId: after.id,
      fields: [
        { name: "Name", value: channelName(after), inline: true },
        { name: "Changes", value: changes.join("\n") },
      ],
      payload: { guildId },
    });
  }

  const oldOverwrites = new Map(overwritesOf(before).map((overwrite) => [overwrite.id, overwrite]));
  const newOverwrites = new Map(overwritesOf(after).map((overwrite) => [overwrite.id, overwrite]));
  const changed: string[] = [];
  for (const id of new Set([...oldOverwrites.keys(), ...newOverwrites.keys()])) {
    const oldValue = oldOverwrites.get(id);
    const newValue = newOverwrites.get(id);
    if (!oldValue || !newValue || overwriteKey(oldValue) !== overwriteKey(newValue)) {
      changed.push(id);
    }
  }
  if (changed.length > 0) {
    events.push({
      category: "server",
      type: "channel.overwrites",
      summary: `Permissions updated for ${channelName(after)}`,
      severity: "warn",
      ...(actor ? { actor } : {}),
      target: { id: after.id, name: channelName(after) },
      channelId: after.id,
      fields: [
        { name: "Channel", value: `<#${after.id}>`, inline: true },
        { name: "Before", value: renderOverwrites(overwritesOf(before)) },
        { name: "After", value: renderOverwrites(overwritesOf(after)) },
      ],
      payload: { guildId, changed },
    });
  }

  return events;
}

export function threadCreateEvent(
  thread: ThreadLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "thread.create",
    summary: `Thread ${channelName(thread)} created`,
    ...(actor ? { actor } : {}),
    target: { id: thread.id, name: channelName(thread) },
    channelId: thread.id,
    fields: [
      { name: "Name", value: channelName(thread), inline: true },
      { name: "Parent", value: thread.parentId ? `<#${thread.parentId}>` : "none", inline: true },
      { name: "Archived", value: thread.archived ? "yes" : "no", inline: true },
    ],
    payload: { guildId },
  };
}

export function threadDeleteEvent(
  thread: ThreadLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "thread.delete",
    summary: `Thread ${channelName(thread)} deleted`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: thread.id, name: channelName(thread) },
    channelId: thread.id,
    fields: [
      { name: "Name", value: channelName(thread), inline: true },
      { name: "Parent", value: thread.parentId ? `<#${thread.parentId}>` : "none", inline: true },
    ],
    payload: { guildId, ...restorePayload(thread) },
  };
}

export function threadUpdateEvents(
  before: ThreadLike,
  after: ThreadLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput[] {
  const changes: string[] = [];
  const properties: [string, unknown, unknown][] = [
    ["name", before.name, after.name],
    ["archived", before.archived, after.archived],
    ["locked", before.locked, after.locked],
    ["slowmode", before.rateLimitPerUser, after.rateLimitPerUser],
  ];
  for (const [label, previous, next] of properties) {
    if (previous !== next) {
      changes.push(`${label}: ${String(previous ?? "none")} → ${String(next ?? "none")}`);
    }
  }

  if (changes.length === 0) {
    return [];
  }

  return [
    {
      category: "server",
      type: "thread.update",
      summary: `Thread ${channelName(after)} updated`,
      ...(actor ? { actor } : {}),
      target: { id: after.id, name: channelName(after) },
      channelId: after.id,
      fields: [
        { name: "Thread", value: `<#${after.id}>`, inline: true },
        { name: "Changes", value: changes.join("\n") },
      ],
      payload: { guildId },
    },
  ];
}

export interface ChannelRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly logger: Logger;
}

interface GuildChannelLike extends ChannelLike {
  readonly guildId?: string | null;
  readonly guild?: { readonly id: string };
}

function guildOf(channel: GuildChannelLike): string | null {
  return channel.guildId ?? channel.guild?.id ?? null;
}

export function registerChannelRecorder(client: Client, deps: ChannelRecorderDeps): void {
  const { config, audit, resolver, security, logger } = deps;
  const recent = (): Date => new Date(Date.now() - 10_000);

  client.on(Events.ChannelCreate, (channel) => {
    void (async () => {
      const guildId = guildOf(channel as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ChannelCreate, channel.id, recent());
      audit.record(channelCreateEvent(channel as unknown as ChannelLike, config.guildId, actor));
      if (actor && security) {
        security.observe({
          kind: "channelCreate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: channel.id,
          targetName: "name" in channel ? channel.name : null,
          at: new Date(),
          payload: channel,
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Channel create recorder failed", serializeError(error));
    });
  });

  client.on(Events.ChannelUpdate, (before, after) => {
    void (async () => {
      const guildId = guildOf(after as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ChannelUpdate, after.id, recent());
      const events = channelUpdateEvents(
        before as unknown as ChannelLike,
        after as unknown as ChannelLike,
        config.guildId,
        actor,
      );
      for (const event of events) {
        audit.record(event);
      }
    })().catch((error: unknown) => {
      logger.warn("Channel update recorder failed", serializeError(error));
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    void (async () => {
      const guildId = guildOf(channel as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ChannelDelete, channel.id, recent());
      const snapshot = channel as unknown as ChannelLike;
      audit.record(channelDeleteEvent(snapshot, config.guildId, actor));
      if (!actor) {
        audit.record(
          attributionFailureEvent({
            guildId: config.guildId,
            type: "channelDelete",
            targetId: channel.id,
            targetName: "name" in channel ? channel.name : null,
          }),
        );
        return;
      }
      security?.observe({
        kind: "channelDelete",
        guildId: config.guildId,
        actorId: actor.id,
        actorTag: actor.tag,
        targetId: channel.id,
        targetName: "name" in channel ? channel.name : null,
        at: new Date(),
        payload: snapshot,
      });
    })().catch((error: unknown) => {
      logger.warn("Channel delete recorder failed", serializeError(error));
    });
  });

  client.on(Events.ThreadCreate, (thread) => {
    void (async () => {
      const guildId = guildOf(thread as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ThreadCreate, thread.id, recent());
      audit.record(threadCreateEvent(thread as unknown as ThreadLike, config.guildId, actor));
      if (actor && security) {
        security.observe({
          kind: "channelCreate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: thread.id,
          targetName: thread.name,
          at: new Date(),
          payload: thread,
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Thread create recorder failed", serializeError(error));
    });
  });

  client.on(Events.ThreadUpdate, (before, after) => {
    void (async () => {
      const guildId = guildOf(after as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ThreadUpdate, after.id, recent());
      const events = threadUpdateEvents(
        before as unknown as ThreadLike,
        after as unknown as ThreadLike,
        config.guildId,
        actor,
      );
      for (const event of events) {
        audit.record(event);
      }
    })().catch((error: unknown) => {
      logger.warn("Thread update recorder failed", serializeError(error));
    });
  });

  client.on(Events.ThreadDelete, (thread) => {
    void (async () => {
      const guildId = guildOf(thread as unknown as GuildChannelLike);
      const guild = client.guilds.cache.get(config.guildId);
      if (guildId !== config.guildId || !guild) {
        return;
      }
      const actor = await resolver.resolve(guild, AuditLogEvent.ThreadDelete, thread.id, recent());
      audit.record(threadDeleteEvent(thread as unknown as ThreadLike, config.guildId, actor));
      if (!actor) {
        audit.record(
          attributionFailureEvent({
            guildId: config.guildId,
            type: "threadDelete",
            targetId: thread.id,
            targetName: thread.name,
          }),
        );
        return;
      }
      security?.observe({
        kind: "threadDelete",
        guildId: config.guildId,
        actorId: actor.id,
        actorTag: actor.tag,
        targetId: thread.id,
        targetName: thread.name,
        at: new Date(),
        payload: thread,
      });
    })().catch((error: unknown) => {
      logger.warn("Thread delete recorder failed", serializeError(error));
    });
  });
}
