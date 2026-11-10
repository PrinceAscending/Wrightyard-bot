import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import {
  AUDIT_CATEGORY_ORDER,
  auditOverwritePlan,
  logChannelName,
  type AuditChannelMap,
} from "./channels.js";
import type { AuditCategory } from "./types.js";

export interface AuditChannelResult {
  readonly categoryId: string;
  readonly channels: AuditChannelMap;
  readonly created: string[];
  readonly warnings: string[];
}

const CATEGORY_NAME = "audit";
const TICKET_CHANNEL_NAME = "tickets";
const MODERATION_CHANNEL_NAME = "mod-log";

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

function channelById(guild: Guild, id: string | null): GuildBasedChannel | null {
  return id ? (guild.channels.cache.get(id) ?? null) : null;
}

function firstNamed(
  guild: Guild,
  name: string,
  parentId?: string,
): GuildBasedChannel | null {
  return (
    guild.channels.cache.find(
      (channel) =>
        channel.name === name &&
        (parentId === undefined || channel.parentId === parentId),
    ) ?? null
  );
}

/**
 * Resolves the audit channel map and creates missing staff-only channels. This
 * is intentionally best-effort: provisioning must never prevent the gateway
 * process from starting.
 */
export async function ensureAuditChannels(
  guild: Guild,
  config: Config,
  logger: Logger,
): Promise<AuditChannelResult> {
  const warnings: string[] = [];
  const created: string[] = [];
  const channels = new Map<AuditCategory, string>();
  let categoryId = config.logCategoryId ?? "";

  try {
    const me = guild.members.me;
    const canManage =
      !me?.permissions || me.permissions.has(PermissionFlagsBits.ManageChannels);
    const botId = me?.id ?? guild.client?.user?.id ?? config.clientId;
    const overwrites = auditOverwritePlan({
      guildId: guild.id,
      botId,
      ownerId: guild.ownerId ?? config.ownerId,
      staffRoleIds: config.staffRoleIds,
    });

    if (!canManage) {
      warnings.push(
        "Manage Channels is missing; existing audit channels were not discovered and missing ones were not created.",
      );
      for (const category of AUDIT_CATEGORY_ORDER) {
        const configured = configuredChannelId(category, config);
        if (configured && guild.channels.cache.has(configured)) {
          channels.set(category, configured);
        }
      }
      if (config.ticketLogChannelId && guild.channels.cache.has(config.ticketLogChannelId)) {
        channels.set("ticket", config.ticketLogChannelId);
      }
      const server = channels.get("server");
      if (server) {
        channels.set("automod", server);
      }
      return { categoryId, channels, created, warnings };
    }

    let category = channelById(guild, config.logCategoryId);
    if (category && category.type !== ChannelType.GuildCategory) {
      warnings.push(
        `LOG_CATEGORY_ID ${category.id} is not a category; looking for #${CATEGORY_NAME}.`,
      );
      category = null;
    }
    category ??= firstNamed(guild, CATEGORY_NAME);
    if (category && category.type !== ChannelType.GuildCategory) {
      warnings.push(`#${CATEGORY_NAME} is not a category; audit channels will use the guild root.`);
      category = null;
    }

    if (!category) {
      try {
        category = await guild.channels.create({
          name: CATEGORY_NAME,
          type: ChannelType.GuildCategory,
          permissionOverwrites: overwrites,
          reason: "Wrightyard audit category",
        });
      } catch (error) {
        logger.warn("Could not create the audit category", serializeError(error));
        warnings.push("Could not create the audit category; audit channels will use the guild root.");
        category = null;
      }
    }
    if (category) {
      categoryId = category.id;
    } else if (!categoryId) {
      warnings.push("No audit category is available; audit channels will use the guild root.");
    }

    const fallbackChannelId =
      config.logChannelId && guild.channels.cache.has(config.logChannelId)
        ? config.logChannelId
        : null;

    for (const auditCategory of AUDIT_CATEGORY_ORDER) {
      const name = logChannelName(auditCategory);
      if (!name) {
        continue;
      }

      let channel = channelById(guild, configuredChannelId(auditCategory, config));
      if (!channel && category) {
        channel = firstNamed(guild, name, category.id);
      }
      if (!channel && auditCategory === "moderation") {
        channel = firstNamed(guild, MODERATION_CHANNEL_NAME);
      }
      if (!channel && fallbackChannelId) {
        channels.set(auditCategory, fallbackChannelId);
        continue;
      }
      if (!channel) {
        try {
          channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            ...(category ? { parent: category.id } : {}),
            topic: `Wrightyard audit: ${auditCategory}. Staff only.`,
            permissionOverwrites: overwrites,
            reason: "Wrightyard audit channel provisioning",
          });
          created.push(name);
        } catch (error) {
          logger.warn("Could not create an audit channel", {
            category: auditCategory,
            error: serializeError(error),
          });
          warnings.push(`Could not create #${name}; ${auditCategory} events will stay in the archive.`);
          continue;
        }
      }

      channels.set(auditCategory, channel.id);
    }

    const server = channels.get("server");
    if (server) {
      channels.set("automod", server);
    }

    let ticket = channelById(guild, config.ticketLogChannelId);
    if (!ticket) {
      ticket = firstNamed(guild, TICKET_CHANNEL_NAME);
    }
    if (ticket) {
      channels.set("ticket", ticket.id);
    } else {
      warnings.push(
        "No ticket log channel is configured or named #tickets; ticket events will stay in the archive.",
      );
    }
  } catch (error) {
    logger.warn("Audit channel provisioning failed", serializeError(error));
    warnings.push(
      `Audit channel provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { categoryId, channels, created, warnings };
}
