import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Channel,
} from "discord.js";
import { UserFacingError } from "../errors.js";
import { isBotStatus } from "../services/presence.js";
import type { BotContext } from "../types.js";
import { buildAdminStatus, buildAnnouncement } from "../views/admin.js";

export async function runAdminStatus(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  const presence = context.presence.snapshot();
  const heartbeat = context.heartbeat.snapshot();
  const members = [...context.client.guilds.cache.values()].reduce(
    (total, guild) => total + guild.memberCount,
    0,
  );

  await interaction.reply({
    embeds: [
      buildAdminStatus({
        version: context.version,
        nodeVersion: process.version,
        uptimeSeconds: context.state.uptimeSeconds(),
        ping: context.client.ws.ping,
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        ready: context.client.isReady(),
        guilds: context.client.guilds.cache.size,
        members,
        commandsServed: context.state.commandsServed,
        lastCommandAt: context.state.lastCommandAt,
        openTickets: context.tickets.openCount,
        maintenance: context.state.maintenance,
        maintenanceSource: context.state.maintenanceSource,
        heartbeat,
        presence,
      }),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function runAnnounce(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.options.getString("title", true).trim();
  const message = interaction.options.getString("message", true).trim();
  if (title.length === 0 || title.length > 100 || message.length === 0 || message.length > 1800) {
    await interaction.editReply("The notice must have a title (1-100) and a message (1-1800).");
    return;
  }

  const selected = interaction.options.getChannel("channel", false);
  let target: Channel | null = selected
    ? (interaction.guild?.channels.cache.get(selected.id) ??
      (await context.client.channels.fetch(selected.id).catch(() => null)))
    : null;

  if (!target && context.config.announcementsChannelId) {
    target = await context.client.channels
      .fetch(context.config.announcementsChannelId)
      .catch(() => null);
  }

  if (!target || (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement)) {
    await interaction.editReply("Choose a text or announcement channel, or set ANNOUNCEMENTS_CHANNEL_ID.");
    return;
  }

  const guild = interaction.guild;
  const me = guild?.members.me;
  if (!guild || !me) {
    await interaction.editReply("I couldn't resolve the guild member record needed to post that notice.");
    return;
  }

  const permissions = target.permissionsFor(me);
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages) ||
    !permissions.has(PermissionFlagsBits.EmbedLinks)
  ) {
    await interaction.editReply("I need View Channel, Send Messages, and Embed Links in that channel.");
    return;
  }

  const sent = await target.send({
    embeds: [buildAnnouncement(title, message)],
    allowedMentions: { parse: [] },
  });

  await interaction.editReply(`Posted in <#${target.id}>: ${sent.url}`);
}

export async function runPresence(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  const text = interaction.options.getString("text", true).trim();
  const status = interaction.options.getString("status", true);

  if (text.length === 0 || text.length > 128) {
    await interaction.reply({
      content: "Presence text must be between 1 and 128 characters.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (!isBotStatus(status)) {
    await interaction.reply({
      content: "Choose one of: online, idle, dnd, invisible.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  context.presence.setLocalOverride(text, status);
  context.presence.refresh();
  const applied = context.presence.snapshot();

  const content =
    applied.source === "website"
      ? "Saved locally. A website heartbeat override is active, so it takes precedence until the site clears it."
      : `Presence set: ${status} · ${text}`;

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function runMaintenance(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  context.state.setLocalMaintenance(enabled);
  context.presence.refresh();

  const websiteControls = context.state.maintenanceSource === "website";
  const effective = context.state.maintenance;
  const content = websiteControls
    ? `Local maintenance saved as ${enabled ? "on" : "off"}, but the website override currently holds the gate ${effective ? "closed" : "open"}. Clear the website override to let the local setting take over.`
    : enabled
      ? "Maintenance is on. The gate is closed, presence is idle, and the heartbeat will report it."
      : "Maintenance is off. The gate is open; the presence rotation resumes unless the website is overriding it.";

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function runSync(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const count = await context.syncer.sync("owner");
  await interaction.editReply(`Re-registered ${count} command${count === 1 ? "" : "s"} in this guild.`);
}

export async function runTicketPanel(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "The panel can only be posted from inside the yard.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await context.tickets.postPanel(guild);
    await interaction.editReply(
      `${result.created ? "Posted" : "Refreshed"} the ticket panel in <#${result.message.channelId}>: ${result.message.url}`,
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }
}
