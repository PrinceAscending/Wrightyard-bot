import { PermissionFlagsBits } from "discord.js";
import type { Config } from "../config.js";
import type { AuditCategory } from "./types.js";

export type AuditChannelMap = ReadonlyMap<AuditCategory, string>;

export interface AuditOverwritePlan {
  readonly id: string;
  readonly allow?: readonly bigint[];
  readonly deny?: readonly bigint[];
}

export const AUDIT_CATEGORY_ORDER: readonly AuditCategory[] = [
  "message",
  "member",
  "server",
  "voice",
  "security",
  "moderation",
];

const DEFAULT_CHANNELS: Partial<Record<AuditCategory, string>> = {
  message: "log-messages",
  member: "log-members",
  server: "log-server",
  voice: "log-voice",
  security: "log-security",
  moderation: "mod-log",
  automod: "log-server",
  ticket: "tickets",
};

export function logChannelName(category: AuditCategory): string | null {
  return DEFAULT_CHANNELS[category] ?? null;
}

export function auditOverwritePlan(input: {
  guildId: string;
  botId: string;
  ownerId: string;
  staffRoleIds: readonly string[];
}): AuditOverwritePlan[] {
  const staffAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  return [
    { id: input.guildId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: input.botId, allow: staffAllow },
    { id: input.ownerId, allow: [PermissionFlagsBits.ViewChannel] },
    ...input.staffRoleIds.map((id) => ({ id, allow: staffAllow })),
  ];
}

function configuredChannelId(category: AuditCategory, config: Config): string | null {
  switch (category) {
    case "message":
      return config.messageLogChannelId;
    case "member":
      return config.memberLogChannelId;
    case "server":
      return config.serverLogChannelId;
    case "voice":
      return config.voiceLogChannelId;
    case "security":
      return config.securityLogChannelId;
    case "moderation":
      return config.modLogChannelId;
    default:
      return null;
  }
}

export function planAuditChannelCreations(
  existingNames: readonly string[],
  config: Config,
): string[] {
  const names = new Set(existingNames);
  return AUDIT_CATEGORY_ORDER.flatMap((category) => {
    if (configuredChannelId(category, config) || config.logChannelId) {
      return [];
    }
    const name = logChannelName(category);
    return name && !names.has(name) ? [name] : [];
  });
}
