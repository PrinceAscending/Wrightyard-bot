import { AuditLogEvent, Events, type Client, type Guild } from "discord.js";
import type { Config } from "../../config.js";
import { serializeError, type Logger } from "../../logger.js";
import type { SecurityObserver } from "../../security/types.js";
import { AuditLogResolver, attributionFailureEvent } from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditActor, AuditEventInput, AuditField } from "../types.js";
import { WebhookTracker } from "../webhooks.js";

export type StructureChange = "create" | "update" | "delete";

export interface RoleLike {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  readonly position: number;
  readonly permissions: string | { readonly bitfield: bigint };
  readonly managed?: boolean;
  readonly icon?: string | null;
  readonly unicodeEmoji?: string | null;
}

export interface EmojiLike {
  readonly id: string;
  readonly name: string | null;
  readonly animated?: boolean;
  readonly managed?: boolean;
}

export interface StickerLike {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly tags?: string | null;
}

interface InviterLike {
  readonly id: string;
  readonly tag?: string;
  readonly username?: string;
}

export interface InviteLike {
  readonly code: string;
  readonly channelId?: string | null;
  readonly channel?: { readonly id: string } | null;
  readonly inviter?: InviterLike | null;
  readonly uses?: number | null;
  readonly maxAge?: number | null;
  readonly maxUses?: number | null;
  readonly temporary?: boolean | null;
}

export interface GuildSettingsLike {
  readonly id?: string;
  readonly name: string;
  readonly icon?: string | null;
  readonly banner?: string | null;
  readonly splash?: string | null;
  readonly verificationLevel?: number;
  readonly explicitContentFilter?: number;
  readonly afkChannelId?: string | null;
  readonly systemChannelId?: string | null;
  readonly preferredLocale?: string;
}

function permissionsText(role: RoleLike): string {
  return typeof role.permissions === "string"
    ? role.permissions
    : role.permissions.bitfield.toString();
}

function rolePresentation(role: RoleLike): AuditField[] {
  return [
    { name: "Name", value: role.name, inline: true },
    { name: "Color", value: `#${role.color.toString(16).padStart(6, "0")}`, inline: true },
    { name: "Hoist", value: role.hoist ? "yes" : "no", inline: true },
    { name: "Mentionable", value: role.mentionable ? "yes" : "no", inline: true },
    { name: "Position", value: String(role.position), inline: true },
  ];
}

export function roleCreateEvent(
  role: RoleLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "role.create",
    summary: `Role ${role.name} created`,
    ...(actor ? { actor } : {}),
    target: { id: role.id, name: role.name },
    fields: [
      ...rolePresentation(role),
      { name: "Permissions", value: permissionsText(role) },
    ],
    payload: { guildId },
  };
}

export function roleDeleteEvent(
  role: RoleLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "role.delete",
    summary: `Role ${role.name} deleted`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: role.id, name: role.name },
    fields: rolePresentation(role),
    payload: {
      guildId,
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      permissions: permissionsText(role),
      managed: role.managed ?? false,
    },
  };
}

export function roleUpdateEvents(
  before: RoleLike,
  after: RoleLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput[] {
  const events: AuditEventInput[] = [];
  const base = {
    category: "server" as const,
    type: "role.update",
    ...(actor ? { actor } : {}),
    target: { id: after.id, name: after.name },
    payload: { guildId },
  };

  if (permissionsText(before) !== permissionsText(after)) {
    events.push({
      ...base,
      summary: `Role ${after.name} permissions updated`,
      severity: "warn",
      fields: [
        { name: "Role", value: `${after.name} (${after.id})`, inline: true },
        { name: "Before", value: permissionsText(before) },
        { name: "After", value: permissionsText(after) },
      ],
    });
  }

  const presentation: string[] = [];
  if (before.name !== after.name) {
    presentation.push(`name: ${before.name} → ${after.name}`);
  }
  if (before.color !== after.color) {
    presentation.push(`color: ${before.color} → ${after.color}`);
  }
  if (before.hoist !== after.hoist) {
    presentation.push(`hoist: ${before.hoist} → ${after.hoist}`);
  }
  if (before.mentionable !== after.mentionable) {
    presentation.push(`mentionable: ${before.mentionable} → ${after.mentionable}`);
  }
  if (before.position !== after.position) {
    presentation.push(`position: ${before.position} → ${after.position}`);
  }

  if (presentation.length > 0) {
    events.push({
      ...base,
      summary: `Role ${after.name} updated`,
      fields: [
        { name: "Role", value: `${after.name} (${after.id})`, inline: true },
        { name: "Changes", value: presentation.join("\n") },
      ],
    });
  }

  return events;
}

export function emojiEvents(
  kind: StructureChange,
  emoji: EmojiLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: `emoji.${kind}`,
    summary: `Emoji ${emoji.name ?? emoji.id} ${kind === "create" ? "created" : `${kind}d`}`,
    severity: kind === "delete" ? "warn" : "info",
    ...(actor ? { actor } : {}),
    target: { id: emoji.id, name: emoji.name ?? undefined },
    fields: [
      { name: "Name", value: emoji.name ?? "unknown", inline: true },
      { name: "ID", value: emoji.id, inline: true },
      { name: "Animated", value: emoji.animated ? "yes" : "no", inline: true },
      { name: "Managed", value: emoji.managed ? "yes" : "no", inline: true },
    ],
    payload: { guildId },
  };
}

export function stickerEvents(
  kind: StructureChange,
  sticker: StickerLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: `sticker.${kind}`,
    summary: `Sticker ${sticker.name} ${kind === "create" ? "created" : `${kind}d`}`,
    severity: kind === "delete" ? "warn" : "info",
    ...(actor ? { actor } : {}),
    target: { id: sticker.id, name: sticker.name },
    fields: [
      { name: "Name", value: sticker.name, inline: true },
      { name: "ID", value: sticker.id, inline: true },
      { name: "Tags", value: sticker.tags || "none" },
      { name: "Description", value: sticker.description || "none" },
    ],
    payload: { guildId, name: sticker.name, tags: sticker.tags ?? null },
  };
}

function inviteChannelId(invite: InviteLike): string | null {
  return invite.channelId ?? invite.channel?.id ?? null;
}

export function inviteCreateEvent(
  invite: InviteLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  const channelId = inviteChannelId(invite);
  return {
    category: "server",
    type: "invite.create",
    summary: `Invite ${invite.code} created`,
    severity: "warn",
    ...(actor || invite.inviter
      ? {
          actor: actor ?? {
            id: invite.inviter!.id,
            tag: invite.inviter!.tag ?? invite.inviter!.username ?? invite.inviter!.id,
          },
        }
      : {}),
    target: { id: invite.code, name: invite.code },
    ...(channelId ? { channelId } : {}),
    fields: [
      { name: "Code", value: invite.code, inline: true },
      { name: "Channel", value: channelId ? `<#${channelId}>` : "unknown", inline: true },
      { name: "Uses", value: String(invite.uses ?? 0), inline: true },
      { name: "Max age", value: `${invite.maxAge ?? 0}s`, inline: true },
      { name: "Max uses", value: String(invite.maxUses ?? 0), inline: true },
      { name: "Temporary", value: invite.temporary ? "yes" : "no", inline: true },
    ],
    payload: { guildId },
  };
}

export function inviteDeleteEvent(
  invite: InviteLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  const channelId = inviteChannelId(invite);
  return {
    category: "server",
    type: "invite.delete",
    summary: `Invite ${invite.code} deleted`,
    ...(actor ? { actor } : {}),
    target: { id: invite.code, name: invite.code },
    ...(channelId ? { channelId } : {}),
    fields: [
      { name: "Code", value: invite.code, inline: true },
      { name: "Channel", value: channelId ? `<#${channelId}>` : "unknown", inline: true },
    ],
    payload: { guildId },
  };
}

export function webhookUpdateEvent(
  channel: { readonly id: string; readonly name?: string },
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "server",
    type: "webhook.update",
    summary: `Webhooks updated in ${channel.name ?? channel.id}`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: channel.id, name: channel.name },
    channelId: channel.id,
    fields: [{ name: "Channel", value: `<#${channel.id}>`, inline: true }],
    payload: { guildId },
  };
}

export function guildUpdateEvents(
  before: GuildSettingsLike,
  after: GuildSettingsLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput[] {
  const groups: { label: string; changes: string[] }[] = [
    {
      label: "Identity",
      changes:
        before.name !== after.name ? [`Name: ${before.name} → ${after.name}`] : [],
    },
    {
      label: "Branding",
      changes: [
        ...(before.icon !== after.icon ? [`Icon: ${before.icon ?? "none"} → ${after.icon ?? "none"}`] : []),
        ...(before.banner !== after.banner
          ? [`Banner: ${before.banner ?? "none"} → ${after.banner ?? "none"}`]
          : []),
        ...(before.splash !== after.splash
          ? [`Splash: ${before.splash ?? "none"} → ${after.splash ?? "none"}`]
          : []),
      ],
    },
    {
      label: "Safety",
      changes: [
        ...(before.verificationLevel !== after.verificationLevel
          ? [`Verification level: ${before.verificationLevel ?? "none"} → ${after.verificationLevel ?? "none"}`]
          : []),
        ...(before.explicitContentFilter !== after.explicitContentFilter
          ? [`Explicit content filter: ${before.explicitContentFilter ?? "none"} → ${after.explicitContentFilter ?? "none"}`]
          : []),
      ],
    },
    {
      label: "Channels",
      changes: [
        ...(before.afkChannelId !== after.afkChannelId
          ? [`AFK channel: ${before.afkChannelId ?? "none"} → ${after.afkChannelId ?? "none"}`]
          : []),
        ...(before.systemChannelId !== after.systemChannelId
          ? [`System channel: ${before.systemChannelId ?? "none"} → ${after.systemChannelId ?? "none"}`]
          : []),
      ],
    },
    {
      label: "Locale",
      changes:
        before.preferredLocale !== after.preferredLocale
          ? [`Preferred locale: ${before.preferredLocale ?? "none"} → ${after.preferredLocale ?? "none"}`]
          : [],
    },
  ];

  return groups
    .filter((group) => group.changes.length > 0)
    .map((group) => ({
      category: "server" as const,
      type: "guild.update",
      summary: `Guild ${group.label.toLowerCase()} updated`,
      severity: group.label === "Safety" ? ("warn" as const) : ("info" as const),
      ...(actor ? { actor } : {}),
      target: { id: guildId, name: after.name },
      fields: [{ name: "Changes", value: group.changes.join("\n") }],
      payload: { guildId, group: group.label },
    }));
}

export interface StructureRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly logger: Logger;
  readonly webhooks?: WebhookTracker;
}

export function registerStructureRecorder(client: Client, deps: StructureRecorderDeps): void {
  const { config, audit, resolver, security, logger } = deps;
  const webhooks =
    deps.webhooks ??
    new WebhookTracker({ resolver, security, logger });
  const recent = (): Date => new Date(Date.now() - 10_000);
  const guild = (): Guild | undefined => client.guilds.cache.get(config.guildId);

  client.once(Events.ClientReady, () => {
    const target = guild();
    if (target) {
      void webhooks.warm(target).catch((error: unknown) => {
        logger.warn("Webhook baseline failed", serializeError(error));
      });
    }
  });

  client.on(Events.GuildRoleCreate, (role) => {
    void (async () => {
      const target = guild();
      if (!target || role.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.RoleCreate, role.id, recent());
      audit.record(roleCreateEvent(role as unknown as RoleLike, config.guildId, actor));
      if (actor && security) {
        security.observe({
          kind: "roleCreate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: role.id,
          targetName: role.name,
          at: new Date(),
          payload: role,
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Role create recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildRoleUpdate, (before, after) => {
    void (async () => {
      const target = guild();
      if (!target || after.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.RoleUpdate, after.id, recent());
      const events = roleUpdateEvents(
        before as unknown as RoleLike,
        after as unknown as RoleLike,
        config.guildId,
        actor,
      );
      for (const event of events) {
        audit.record(event);
      }
    })().catch((error: unknown) => {
      logger.warn("Role update recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildRoleDelete, (role) => {
    void (async () => {
      const target = guild();
      if (!target || role.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.RoleDelete, role.id, recent());
      audit.record(roleDeleteEvent(role as unknown as RoleLike, config.guildId, actor));
      if (!actor) {
        audit.record(
          attributionFailureEvent({
            guildId: config.guildId,
            type: "roleDelete",
            targetId: role.id,
            targetName: role.name,
          }),
        );
        return;
      }
      security?.observe({
        kind: "roleDelete",
        guildId: config.guildId,
        actorId: actor.id,
        actorTag: actor.tag,
        targetId: role.id,
        targetName: role.name,
        at: new Date(),
        payload: role,
      });
    })().catch((error: unknown) => {
      logger.warn("Role delete recorder failed", serializeError(error));
    });
  });

  type GenericOn = (event: string, listener: (...args: unknown[]) => void) => void;
  const on = (client as unknown as { on: GenericOn }).on.bind(client) as GenericOn;

  const listenExpression = (
    eventName: string,
    auditType: AuditLogEvent,
    build: (value: EmojiLike | StickerLike, actor: AuditActor | null) => AuditEventInput,
    observeKind: "emojiDelete" | "stickerDelete" | null,
  ): void => {
    on(eventName, (raw) => {
      const value = raw as EmojiLike | StickerLike;
      void (async () => {
        const target = guild();
        if (!target) {
          return;
        }
        const actor = await resolver.resolve(target, auditType, value.id, recent());
        audit.record(build(value, actor));
        if (actor && security && observeKind) {
          security.observe({
            kind: observeKind,
            guildId: config.guildId,
            actorId: actor.id,
            actorTag: actor.tag,
            targetId: value.id,
            targetName: value.name,
            at: new Date(),
            payload: value,
          });
        }
      })().catch((error: unknown) => {
        logger.warn("Expression recorder failed", serializeError(error));
      });
    });
  };

  listenExpression(Events.GuildEmojiCreate, AuditLogEvent.EmojiCreate, (value, actor) =>
    emojiEvents("create", value as EmojiLike, config.guildId, actor), null);
  listenExpression(Events.GuildEmojiUpdate, AuditLogEvent.EmojiUpdate, (value, actor) =>
    emojiEvents("update", value as EmojiLike, config.guildId, actor), null);
  listenExpression(Events.GuildEmojiDelete, AuditLogEvent.EmojiDelete, (value, actor) =>
    emojiEvents("delete", value as EmojiLike, config.guildId, actor), "emojiDelete");
  listenExpression(Events.GuildStickerCreate, AuditLogEvent.StickerCreate, (value, actor) =>
    stickerEvents("create", value as StickerLike, config.guildId, actor), null);
  listenExpression(Events.GuildStickerUpdate, AuditLogEvent.StickerUpdate, (value, actor) =>
    stickerEvents("update", value as StickerLike, config.guildId, actor), null);
  listenExpression(Events.GuildStickerDelete, AuditLogEvent.StickerDelete, (value, actor) =>
    stickerEvents("delete", value as StickerLike, config.guildId, actor), "stickerDelete");

  client.on(Events.InviteCreate, (invite) => {
    void (async () => {
      const target = guild();
      if (!target || invite.guild?.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.InviteCreate, invite.code, recent());
      audit.record(inviteCreateEvent(invite as unknown as InviteLike, config.guildId, actor));
      if (actor && security) {
        security.observe({
          kind: "inviteCreate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: invite.code,
          targetName: invite.code,
          at: new Date(),
          payload: invite,
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Invite create recorder failed", serializeError(error));
    });
  });

  client.on(Events.InviteDelete, (invite) => {
    void (async () => {
      const target = guild();
      if (!target || invite.guild?.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.InviteDelete, invite.code, recent());
      audit.record(inviteDeleteEvent(invite as unknown as InviteLike, config.guildId, actor));
    })().catch((error: unknown) => {
      logger.warn("Invite delete recorder failed", serializeError(error));
    });
  });

  client.on(Events.WebhooksUpdate, (channel) => {
    void (async () => {
      const target = guild();
      if (!target || channel.guildId !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(target, AuditLogEvent.WebhookUpdate, null, recent());
      audit.record(webhookUpdateEvent(channel, config.guildId, actor));
      await webhooks.handle(channel);
    })().catch((error: unknown) => {
      logger.warn("Webhook update recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildUpdate, (before, after) => {
    void (async () => {
      if (after.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(after, AuditLogEvent.GuildUpdate, after.id, recent());
      const events = guildUpdateEvents(
        before as unknown as GuildSettingsLike,
        after as unknown as GuildSettingsLike,
        config.guildId,
        actor,
      );
      for (const event of events) {
        audit.record(event);
      }
      if (actor && security) {
        security.observe({
          kind: "guildUpdate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: config.guildId,
          targetName: after.name,
          at: new Date(),
          payload: { before, after },
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Guild update recorder failed", serializeError(error));
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    webhooks.forget(channel.id);
  });
}
