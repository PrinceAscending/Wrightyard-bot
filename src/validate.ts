import {
  ChannelType,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import type { Config } from "./config.js";
import { GATEWAY_INTENTS } from "./intents.js";
import type { Logger } from "./logger.js";

interface ChannelCheck {
  readonly name: string;
  readonly id: string | null;
  readonly types: readonly ChannelType[];
}

/** Guild permissions the full logging, staff, and security surface needs. */
export const REQUIRED_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
];

export async function validateGuildConfiguration(
  client: Client,
  config: Config,
  logger: Logger,
): Promise<void> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    logger.error("Configured guild is not cached. Check DISCORD_GUILD_ID and the bot invite.", {
      guildId: config.guildId,
    });
    return;
  }

  logger.info("Yard located", {
    guildId: guild.id,
    name: guild.name,
    members: guild.memberCount,
  });

  const checks: ChannelCheck[] = [
    { name: "announcements", id: config.announcementsChannelId, types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
    { name: "ticket panel", id: config.ticketPanelChannelId, types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] },
    { name: "ticket log", id: config.ticketLogChannelId, types: [ChannelType.GuildText] },
    { name: "ticket category", id: config.ticketCategoryId, types: [ChannelType.GuildCategory] },
    { name: "welcome", id: config.welcomeChannelId, types: [ChannelType.GuildText] },
    { name: "level-up", id: config.levelUpChannelId, types: [ChannelType.GuildText] },
    { name: "audit category", id: config.logCategoryId, types: [ChannelType.GuildCategory] },
    { name: "message log", id: config.messageLogChannelId, types: [ChannelType.GuildText] },
    { name: "member log", id: config.memberLogChannelId, types: [ChannelType.GuildText] },
    { name: "server log", id: config.serverLogChannelId, types: [ChannelType.GuildText] },
    { name: "voice log", id: config.voiceLogChannelId, types: [ChannelType.GuildText] },
    { name: "security log", id: config.securityLogChannelId, types: [ChannelType.GuildText] },
    { name: "mod log", id: config.modLogChannelId, types: [ChannelType.GuildText] },
  ];

  for (const check of checks) {
    if (!check.id) {
      continue;
    }
    const channel = guild.channels.cache.get(check.id);
    if (!channel) {
      logger.warn(`Configured ${check.name} channel is not visible to the bot.`, { channelId: check.id });
      continue;
    }
    if (!check.types.includes(channel.type)) {
      logger.warn(`Configured ${check.name} channel has an unexpected type.`, {
        channelId: check.id,
        type: channel.type,
      });
    }
  }

  for (const roleId of config.staffRoleIds) {
    if (!guild.roles.cache.has(roleId)) {
      logger.warn("Configured staff role is not present in the guild.", { roleId });
    }
  }

  if (
    config.antiNukeQuarantineRoleId &&
    !guild.roles.cache.has(config.antiNukeQuarantineRoleId)
  ) {
    logger.warn("Configured quarantine role is not present in the guild.", {
      roleId: config.antiNukeQuarantineRoleId,
    });
  }

  if (
    config.logMessageContent &&
    !GATEWAY_INTENTS.includes(GatewayIntentBits.MessageContent)
  ) {
    logger.warn(
      "LOG_MESSAGE_CONTENT is on but the Message Content intent is not requested; content will not be stored.",
    );
  }

  for (const roleId of config.autoRoleIds) {
    if (!guild.roles.cache.has(roleId)) {
      logger.warn("Configured auto-role is not present in the guild.", { roleId });
    }
  }

  for (const roleId of config.botAutoRoleIds) {
    if (!guild.roles.cache.has(roleId)) {
      logger.warn("Configured bot auto-role is not present in the guild.", { roleId });
    }
  }

  for (const entry of config.levelRoles) {
    if (!guild.roles.cache.has(entry.roleId)) {
      logger.warn("Configured level role is not present in the guild.", {
        level: entry.level,
        roleId: entry.roleId,
      });
    }
  }

  const owner = await guild.members.fetch(config.ownerId).catch(() => null);
  if (!owner) {
    logger.warn("Configured owner is not a member of the guild.", { ownerId: config.ownerId });
  }

  const me = guild.members.me;
  if (!me) {
    logger.error("The bot's guild member record is missing.");
    return;
  }

  const missing = REQUIRED_PERMISSIONS.filter(
    (permission) => !me.permissions.has(permission),
  );
  if (missing.length > 0) {
    logger.warn("The bot is missing permissions needed for the full yard experience.", {
      permissions: missing.map((permission) => permission.toString()),
    });
  } else {
    logger.info("Bot permissions for the yard are present.");
  }
}
