import type { GuildMember } from "discord.js";
import { serializeError, type Logger } from "../logger.js";

export interface RaidJoinObserver {
  observeJoin(member: GuildMember): Promise<{ contained: boolean }>;
}

export interface CommunityJoinHandler {
  onMemberJoin(member: GuildMember): Promise<unknown>;
}

export interface MemberJoinOptions {
  readonly member: GuildMember;
  readonly raid: RaidJoinObserver;
  readonly community: CommunityJoinHandler;
  readonly logger: Logger;
}

export type MemberJoinOutcome = "contained" | "community" | "failed";

/**
 * Raid containment runs before auto-role and welcome. A contained join never
 * receives a community role or a welcome message; a raid-guard failure still
 * lets the normal join path run so an outage cannot strand new members.
 */
export async function handleMemberJoin(
  options: MemberJoinOptions,
): Promise<MemberJoinOutcome> {
  try {
    const result = await options.raid.observeJoin(options.member);
    if (result.contained) {
      return "contained";
    }
  } catch (error) {
    options.logger.warn("Raid guard evaluation failed; continuing the join", {
      userId: options.member.id,
      ...serializeError(error),
    });
  }

  try {
    await options.community.onMemberJoin(options.member);
    return "community";
  } catch (error) {
    options.logger.warn("Member join handling failed", {
      userId: options.member.id,
      ...serializeError(error),
    });
    return "failed";
  }
}
