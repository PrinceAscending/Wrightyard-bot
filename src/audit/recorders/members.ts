import { AuditLogEvent, Events, type Client } from "discord.js";
import type { Config } from "../../config.js";
import { formatTimestamp, truncate } from "../../format.js";
import { serializeError, type Logger } from "../../logger.js";
import type { SecurityObserver } from "../../security/types.js";
import { AuditLogResolver, attributionFailureEvent } from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditActor, AuditEventInput, AuditField } from "../types.js";

interface UserLike {
  readonly id: string;
  readonly tag?: string;
  readonly username?: string;
  readonly bot?: boolean;
  readonly createdTimestamp: number;
  avatarURL?(): string | null;
}

export interface MemberLike {
  readonly id: string;
  readonly user: UserLike;
  readonly guildId?: string;
  readonly joinedTimestamp?: number | null;
  readonly nickname?: string | null;
  readonly communicationDisabledUntilTimestamp?: number | null;
  readonly roles: { readonly cache: { keys(): IterableIterator<string> } };
  avatarURL?(): string | null;
}

function tagOf(user: UserLike): string {
  return user.tag ?? user.username ?? user.id;
}

function memberName(member: MemberLike): string {
  return member.nickname ? `${member.nickname} (${tagOf(member.user)})` : tagOf(member.user);
}

function roleIds(member: MemberLike): Set<string> {
  return new Set(member.roles.cache.keys());
}

function roleMentions(ids: Iterable<string>): string {
  const list = [...ids];
  return list.length > 0 ? list.map((id) => `<@&${id}>`).join(", ") : "none";
}

function accountAgeDays(user: UserLike): number {
  return Math.max(0, Math.floor((Date.now() - user.createdTimestamp) / 86_400_000));
}

function baseMemberFields(member: MemberLike): AuditField[] {
  return [
    { name: "Member", value: `${memberName(member)} (${member.id})`, inline: true },
    { name: "Bot", value: member.user.bot ? "yes" : "no", inline: true },
    { name: "Account age", value: `${accountAgeDays(member.user)} days` },
    { name: "Roles", value: roleMentions(roleIds(member)) },
  ];
}

export function memberJoinEvent(member: MemberLike, guildId: string): AuditEventInput {
  const joined =
    member.joinedTimestamp !== undefined && member.joinedTimestamp !== null
      ? formatTimestamp(new Date(member.joinedTimestamp))
      : "unknown";
  return {
    category: "member",
    type: "member.join",
    summary: `${memberName(member)} joined`,
    actor: { id: member.id, tag: tagOf(member.user) },
    target: { id: member.id, name: tagOf(member.user) },
    fields: [
      ...baseMemberFields(member),
      { name: "Joined", value: joined },
    ],
    payload: { guildId },
  };
}

export function memberLeaveEvent(
  member: MemberLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "member",
    type: actor ? "member.kick" : "member.leave",
    summary: actor
      ? `${memberName(member)} was kicked by ${actor.tag}`
      : `${memberName(member)} left`,
    severity: actor ? "warn" : "info",
    ...(actor ? { actor } : {}),
    target: { id: member.id, name: tagOf(member.user) },
    fields: [
      { name: "Member", value: `${memberName(member)} (${member.id})`, inline: true },
      { name: "Bot", value: member.user.bot ? "yes" : "no", inline: true },
      { name: "Roles", value: roleMentions(roleIds(member)) },
    ],
    payload: { guildId },
  };
}

export function memberUpdateEvents(
  before: MemberLike,
  after: MemberLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput[] {
  const events: AuditEventInput[] = [];
  const previousRoles = roleIds(before);
  const nextRoles = roleIds(after);
  const added = [...nextRoles].filter((id) => !previousRoles.has(id));
  const removed = [...previousRoles].filter((id) => !nextRoles.has(id));

  if (added.length > 0 || removed.length > 0) {
    events.push({
      category: "member",
      type: "member.roles",
      summary: `Roles updated for ${memberName(after)}`,
      severity: "warn",
      ...(actor ? { actor } : {}),
      target: { id: after.id, name: tagOf(after.user) },
      fields: [
        { name: "Member", value: `${memberName(after)} (${after.id})`, inline: true },
        { name: "Added", value: roleMentions(added) },
        { name: "Removed", value: roleMentions(removed) },
      ],
      payload: { added, removed, guildId },
    });
  }

  const changes: { label: string; before: string; after: string }[] = [];
  const beforeNick = before.nickname ?? "(none)";
  const afterNick = after.nickname ?? "(none)";
  if (beforeNick !== afterNick) {
    changes.push({ label: "Nickname", before: beforeNick, after: afterNick });
  }
  const beforeTimeout = Boolean(before.communicationDisabledUntilTimestamp);
  const afterTimeout = Boolean(after.communicationDisabledUntilTimestamp);
  if (beforeTimeout !== afterTimeout) {
    changes.push({
      label: "Timed out",
      before: beforeTimeout ? "yes" : "no",
      after: afterTimeout ? "yes" : "no",
    });
  }
  const beforeUsername = before.user.username ?? before.user.id;
  const afterUsername = after.user.username ?? after.user.id;
  if (beforeUsername !== afterUsername) {
    changes.push({ label: "Username", before: beforeUsername, after: afterUsername });
  }
  const beforeAvatar = before.avatarURL?.() ?? null;
  const afterAvatar = after.avatarURL?.() ?? null;
  if (beforeAvatar !== afterAvatar) {
    changes.push({
      label: "Avatar",
      before: beforeAvatar ?? "(none)",
      after: afterAvatar ?? "(none)",
    });
  }

  if (changes.length > 0) {
    events.push({
      category: "member",
      type: "member.update",
      summary: `${memberName(after)} profile updated`,
      ...(actor ? { actor } : {}),
      target: { id: after.id, name: tagOf(after.user) },
      fields: [
        { name: "Member", value: `${memberName(after)} (${after.id})`, inline: true },
        {
          name: "Before",
          value: truncate(changes.map((change) => `${change.label}: ${change.before}`).join("\n"), 1024),
        },
        {
          name: "After",
          value: truncate(changes.map((change) => `${change.label}: ${change.after}`).join("\n"), 1024),
        },
      ],
      payload: { guildId },
    });
  }

  return events;
}

export function memberBanEvent(
  user: UserLike,
  guildId: string,
  actor: AuditActor | null,
  reason: string | null,
): AuditEventInput {
  return {
    category: "member",
    type: "member.ban",
    summary: `${tagOf(user)} was banned${actor ? ` by ${actor.tag}` : ""}`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: user.id, name: tagOf(user) },
    fields: [
      { name: "User", value: `${tagOf(user)} (${user.id})`, inline: true },
      { name: "Reason", value: reason ?? "no reason supplied" },
    ],
    payload: { guildId },
  };
}

export function memberUnbanEvent(
  user: UserLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  return {
    category: "member",
    type: "member.unban",
    summary: `${tagOf(user)} was unbanned${actor ? ` by ${actor.tag}` : ""}`,
    severity: "warn",
    ...(actor ? { actor } : {}),
    target: { id: user.id, name: tagOf(user) },
    fields: [{ name: "User", value: `${tagOf(user)} (${user.id})`, inline: true }],
    payload: { guildId },
  };
}

export interface MemberRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly logger: Logger;
}

export function registerMemberRecorder(client: Client, deps: MemberRecorderDeps): void {
  const { config, audit, resolver, security, logger } = deps;
  const recent = (): Date => new Date(Date.now() - 10_000);

  client.on(Events.GuildMemberAdd, (member) => {
    void (async () => {
      if (member.guild.id !== config.guildId) {
        return;
      }
      audit.record(memberJoinEvent(member as unknown as MemberLike, config.guildId));
    })().catch((error: unknown) => {
      logger.warn("Member join recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildMemberRemove, (member) => {
    void (async () => {
      if (member.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        member.guild,
        AuditLogEvent.MemberKick,
        member.id,
        recent(),
      );
      audit.record(
        memberLeaveEvent(member as unknown as MemberLike, config.guildId, actor),
      );
      if (actor && security) {
        security.observe({
          kind: "kick",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: member.id,
          targetName: tagOf(member.user),
          at: new Date(),
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Member leave recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildMemberUpdate, (before, after) => {
    void (async () => {
      if (after.guild.id !== config.guildId) {
        return;
      }
      const beforeRoles = roleIds(before as unknown as MemberLike);
      const afterRoles = roleIds(after as unknown as MemberLike);
      const rolesChanged =
        beforeRoles.size !== afterRoles.size ||
        [...afterRoles].some((id) => !beforeRoles.has(id));

      const actor = rolesChanged
        ? await resolver.resolve(
            after.guild,
            AuditLogEvent.MemberRoleUpdate,
            after.id,
            recent(),
          )
        : null;

      const events = memberUpdateEvents(
        before as unknown as MemberLike,
        after as unknown as MemberLike,
        config.guildId,
        actor,
      );
      for (const event of events) {
        audit.record(event);
      }

      if (rolesChanged && actor && security) {
        security.observe({
          kind: "memberRoleUpdate",
          guildId: config.guildId,
          actorId: actor.id,
          actorTag: actor.tag,
          targetId: after.id,
          targetName: tagOf(after.user),
          at: new Date(),
        });
      }
    })().catch((error: unknown) => {
      logger.warn("Member update recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildBanAdd, (ban) => {
    void (async () => {
      if (ban.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        ban.guild,
        AuditLogEvent.MemberBanAdd,
        ban.user.id,
        recent(),
      );
      audit.record(
        memberBanEvent(ban.user as unknown as UserLike, config.guildId, actor, null),
      );
      if (!actor) {
        audit.record(
          attributionFailureEvent({
            guildId: config.guildId,
            type: "ban",
            targetId: ban.user.id,
            targetName: tagOf(ban.user as unknown as UserLike),
          }),
        );
        return;
      }
      security?.observe({
        kind: "ban",
        guildId: config.guildId,
        actorId: actor.id,
        actorTag: actor.tag,
        targetId: ban.user.id,
        targetName: tagOf(ban.user as unknown as UserLike),
        at: new Date(),
      });
    })().catch((error: unknown) => {
      logger.warn("Member ban recorder failed", serializeError(error));
    });
  });

  client.on(Events.GuildBanRemove, (ban) => {
    void (async () => {
      if (ban.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        ban.guild,
        AuditLogEvent.MemberBanRemove,
        ban.user.id,
        recent(),
      );
      audit.record(
        memberUnbanEvent(ban.user as unknown as UserLike, config.guildId, actor),
      );
    })().catch((error: unknown) => {
      logger.warn("Member unban recorder failed", serializeError(error));
    });
  });
}
