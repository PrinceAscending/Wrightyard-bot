import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../types.js";
import { buildStatusEmbed, siteButtonRows } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("A live reading from the yard: uptime, latency, members, and open tickets.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 5,
  async execute(interaction, context) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "The yard lives in a server. Run this there.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const embed = buildStatusEmbed({
      maintenance: context.state.maintenance,
      uptimeSeconds: context.state.uptimeSeconds(),
      ping: context.client.ws.ping,
      memberCount: interaction.guild.memberCount,
      openTickets: context.tickets.openCount,
      commandsServed: context.state.commandsServed,
    });

    await interaction.reply({
      embeds: [embed],
      components: siteButtonRows(context.config.siteUrl),
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
