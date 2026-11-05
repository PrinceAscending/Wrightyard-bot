import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { channelUrl } from "../brand.js";
import type { Command } from "../types.js";
import { buildTicketPanel, ticketPanelRow } from "../views/tickets.js";

export default {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Open a private room with the studio.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 5,
  async execute(interaction, context) {
    if (context.state.maintenance) {
      await interaction.reply({
        content: "The yard is closed for maintenance. The gate reopens when the work is done.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (context.config.staffRoleIds.length === 0) {
      await interaction.reply({
        content: "Ticket intake is not configured on this deployment. A studio member can open the gate.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const components = [ticketPanelRow()];
    if (context.config.ticketPanelChannelId) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("Go to the gate")
            .setStyle(ButtonStyle.Link)
            .setURL(channelUrl(context.config.guildId, context.config.ticketPanelChannelId)),
        ),
      );
    }

    await interaction.reply({
      embeds: [buildTicketPanel()],
      components,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
