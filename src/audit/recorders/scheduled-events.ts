import { AuditLogEvent, Events, type Client } from "discord.js";
import type { Config } from "../../config.js";
import { formatTimestamp } from "../../format.js";
import { serializeError, type Logger } from "../../logger.js";
import { AuditLogResolver } from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditEventInput, AuditField } from "../types.js";

export type ScheduledEventChange =
  | "create"
  | "update"
  | "delete"
  | "userAdd"
  | "userRemove";

interface ScheduledUserLike {
  readonly id: string;
  readonly tag?: string;
  readonly username?: string;
}

export interface ScheduledEventLike {
  readonly id: string;
  readonly name: string;
  readonly guildId?: string | null;
  readonly description?: string | null;
  readonly scheduledStartTimestamp?: number | null;
  readonly scheduledEndTimestamp?: number | null;
  readonly status?: number | string;
  readonly entityType?: number | string;
  readonly channelId?: string | null;
  readonly entityMetadata?: { readonly location?: string | null } | null;
  readonly userCount?: number;
}

function valueLabel(value: number | string | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

function timestamp(value: number | null | undefined): string {
  return value ? formatTimestamp(new Date(value)) : "none";
}

export function scheduledEventEvent(
  kind: ScheduledEventChange,
  event: ScheduledEventLike,
  guildId: string,
  user?: ScheduledUserLike,
): AuditEventInput {
  const verb =
    kind === "create"
      ? "created"
      : kind === "update"
        ? "updated"
        : kind === "delete"
          ? "deleted"
          : kind === "userAdd"
            ? "joined by a member"
            : "left by a member";
  const type = `scheduledEvent.${kind}`;

  const fields: AuditField[] = [
    { name: "Event", value: event.name, inline: true },
    { name: "Start", value: timestamp(event.scheduledStartTimestamp), inline: true },
    { name: "End", value: timestamp(event.scheduledEndTimestamp), inline: true },
    { name: "Status", value: valueLabel(event.status), inline: true },
    { name: "Entity", value: valueLabel(event.entityType), inline: true },
  ];
  if (event.description) {
    fields.push({ name: "Description", value: event.description });
  }
  if (event.channelId) {
    fields.push({ name: "Channel", value: `<#${event.channelId}>`, inline: true });
  } else if (event.entityMetadata?.location) {
    fields.push({ name: "Location", value: event.entityMetadata.location, inline: true });
  }
  if (user) {
    fields.push({
      name: "User",
      value: `${user.tag ?? user.username ?? user.id} (${user.id})`,
      inline: true,
    });
  }

  return {
    category: "server",
    type,
    summary: `Scheduled event ${event.name} ${verb}`,
    severity: kind === "delete" ? "warn" : "info",
    ...(user
      ? { actor: { id: user.id, tag: user.tag ?? user.username ?? user.id } }
      : {}),
    target: { id: event.id, name: event.name },
    ...(event.channelId ? { channelId: event.channelId } : {}),
    fields,
    payload: { guildId },
  };
}

export interface ScheduledEventRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly logger: Logger;
}

export function registerScheduledEventRecorder(
  client: Client,
  deps: ScheduledEventRecorderDeps,
): void {
  const { config, audit, resolver, logger } = deps;
  const recent = (): Date => new Date(Date.now() - 10_000);

  client.on(Events.GuildScheduledEventCreate, (event) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || event.guildId !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.GuildScheduledEventCreate,
        event.id,
        recent(),
      );
      audit.record(
        scheduledEventEvent(
          "create",
          event as unknown as ScheduledEventLike,
          config.guildId,
          actor ? { id: actor.id, tag: actor.tag } : undefined,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Scheduled event create recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildScheduledEventUpdate, (before, after) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || after.guildId !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.GuildScheduledEventUpdate,
        after.id,
        recent(),
      );
      audit.record(
        scheduledEventEvent(
          "update",
          after as unknown as ScheduledEventLike,
          config.guildId,
          actor ? { id: actor.id, tag: actor.tag } : undefined,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Scheduled event update recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildScheduledEventDelete, (event) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || event.guildId !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.GuildScheduledEventDelete,
        event.id,
        recent(),
      );
      audit.record(
        scheduledEventEvent(
          "delete",
          event as unknown as ScheduledEventLike,
          config.guildId,
          actor ? { id: actor.id, tag: actor.tag } : undefined,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Scheduled event delete recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildScheduledEventUserAdd, (event, user) => {
    void (async () => {
      if (event.guildId !== config.guildId) {
        return;
      }
      audit.record(
        scheduledEventEvent(
          "userAdd",
          event as unknown as ScheduledEventLike,
          config.guildId,
          user as unknown as ScheduledUserLike,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Scheduled event user add recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildScheduledEventUserRemove, (event, user) => {
    void (async () => {
      if (event.guildId !== config.guildId) {
        return;
      }
      audit.record(
        scheduledEventEvent(
          "userRemove",
          event as unknown as ScheduledEventLike,
          config.guildId,
          user as unknown as ScheduledUserLike,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Scheduled event user remove recorder failed", serializeError(error));
    });
  });
}

