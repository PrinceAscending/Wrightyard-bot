import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

interface ChannelCheck {
  readonly name: string;
  readonly id: string | null;
  readonly types: readonly ChannelType[];
}

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

  for (const roleId of config.autoRoleIds) {
    if (!guild.roles.cache.has(roleId)) {
      logger.warn("Configured auto-role is not present in the guild.", { roleId });
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

  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
  ];
  const missing = required.filter((permission) => !me.permissions.has(permission));
  if (missing.length > 0) {
    logger.warn("The bot is missing permissions needed for the full yard experience.", {
      permissions: missing.map((permission) => permission.toString()),
    });
  } else {
    logger.info("Bot permissions for the yard are present.");
  }
}
