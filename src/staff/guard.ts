import type { Config } from "../config.js";
import { atLeast, type StaffRank } from "./ranks.js";

export type GuardResult = { ok: true } | { ok: false; reason: string };

export type PermissionHolder =
  | readonly bigint[]
  | { has(permission: bigint): boolean };

export interface ModerationGuardInput {
  readonly actorId: string;
  readonly actorRank: StaffRank;
  readonly actorPosition: number;
  readonly targetId: string;
  readonly targetPosition: number;
  readonly targetIsBot?: boolean;
  readonly guildOwnerId?: string;
  readonly botId?: string;
  readonly botPosition: number;
  readonly botPermissions?: PermissionHolder;
  readonly config?: Config;
  readonly minimumRank: StaffRank;
  readonly requiredPermission?: bigint;
}

function holdsPermission(
  holder: PermissionHolder | undefined,
  permission: bigint,
): boolean {
  if (!holder) {
    return false;
  }
  if (Array.isArray(holder)) {
    return holder.includes(permission);
  }
  return (holder as { has(permission: bigint): boolean }).has(permission);
}

/**
 * Runs the guard order from Spec §5.3. Callers reply ephemerally with `reason`
 * and never create a case when the result is not ok.
 */
export function canModerate(input: ModerationGuardInput): GuardResult {
  if (!atLeast(input.actorRank, input.minimumRank)) {
    return {
      ok: false,
      reason: `You need ${input.minimumRank} rank or higher for this action.`,
    };
  }

  if (input.actorId === input.targetId) {
    return { ok: false, reason: "You cannot moderate yourself." };
  }

  const guildOwnerId = input.guildOwnerId ?? input.config?.ownerId;
  if (guildOwnerId && input.targetId === guildOwnerId) {
    return { ok: false, reason: "You cannot moderate the server owner." };
  }

  if (input.targetIsBot || (input.botId && input.targetId === input.botId)) {
    return { ok: false, reason: "You cannot moderate a bot." };
  }

  if (input.botPosition <= input.targetPosition) {
    return {
      ok: false,
      reason: "Bot hierarchy: my highest role is not above the target's highest role.",
    };
  }

  if (input.actorRank !== "founder" && input.actorPosition <= input.targetPosition) {
    return {
      ok: false,
      reason: "Role hierarchy: your highest role is not above the target's highest role.",
    };
  }

  if (
    input.requiredPermission !== undefined &&
    !holdsPermission(input.botPermissions, input.requiredPermission)
  ) {
    return { ok: false, reason: "I do not have the permission required for this action." };
  }

  return { ok: true };
}
