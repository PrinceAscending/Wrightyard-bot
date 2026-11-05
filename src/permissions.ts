import type { APIGuildMember, GuildMember } from "discord.js";
import type { Config } from "./config.js";

export function isOwner(userId: string, config: Config): boolean {
  return userId === config.ownerId;
}

/**
 * Interaction members may be a cached GuildMember or the raw API member.
 * Both carry role IDs, so staff checks work without the GuildMembers intent.
 */
export function memberRoleIds(member: GuildMember | APIGuildMember | null): ReadonlySet<string> {
  if (!member) {
    return new Set();
  }

  if (Array.isArray(member.roles)) {
    return new Set(member.roles);
  }

  const roleManager = member.roles as GuildMember["roles"];
  return new Set(roleManager.cache.keys());
}

export function hasStaffRole(
  member: GuildMember | APIGuildMember | null,
  staffRoleIds: readonly string[],
): boolean {
  if (staffRoleIds.length === 0) {
    return false;
  }
  const roles = memberRoleIds(member);
  return staffRoleIds.some((roleId) => roles.has(roleId));
}
