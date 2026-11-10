import type { APIGuildMember, GuildMember } from "discord.js";
import type { Config } from "../config.js";
import { memberRoleIds } from "../permissions.js";

export type StaffRank = "none" | "moderator" | "steward" | "admin" | "founder";

export const RANK_ORDER: readonly StaffRank[] = [
  "none",
  "moderator",
  "steward",
  "admin",
  "founder",
];

export function atLeast(rank: StaffRank, minimum: StaffRank): boolean {
  return RANK_ORDER.indexOf(rank) >= RANK_ORDER.indexOf(minimum);
}

function memberId(member: GuildMember | APIGuildMember): string {
  return "id" in member && typeof member.id === "string" ? member.id : member.user.id;
}

function hasAny(roles: ReadonlySet<string>, roleIds: readonly string[]): boolean {
  return roleIds.some((roleId) => roles.has(roleId));
}

export function resolveStaffRank(
  member: GuildMember | APIGuildMember | null,
  config: Config,
  ownerId?: string,
): StaffRank {
  if (!member) {
    return "none";
  }
  if (memberId(member) === (ownerId ?? config.ownerId)) {
    return "founder";
  }

  const roles = memberRoleIds(member);
  if (hasAny(roles, config.staffFounderRoleIds)) {
    return "founder";
  }
  if (hasAny(roles, config.staffAdminRoleIds)) {
    return "admin";
  }
  if (hasAny(roles, config.staffStewardRoleIds)) {
    return "steward";
  }
  if (hasAny(roles, config.staffModeratorRoleIds)) {
    return "moderator";
  }

  const tiersConfigured =
    config.staffFounderRoleIds.length +
      config.staffAdminRoleIds.length +
      config.staffStewardRoleIds.length +
      config.staffModeratorRoleIds.length >
    0;
  if (!tiersConfigured && hasAny(roles, config.staffRoleIds)) {
    return "moderator";
  }
  return "none";
}
