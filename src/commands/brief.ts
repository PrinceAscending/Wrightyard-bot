import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { BRAND, channelUrl, siteUrl } from "../brand.js";
import { AIBusyError } from "../services/ai.js";
import type { Command } from "../types.js";

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("brief")
    .setDescription("Turn a rough project idea into a short studio brief.")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("idea")
        .setDescription("What are you trying to build? A sentence or two is enough.")
        .setMaxLength(1_500)
        .setRequired(true),
    ),
  cooldownSeconds: 30,
  async execute(interaction, context) {
    if (!context.ai.enabled) {
      await interaction.reply({
        content: "The AI bench is not wired on this deployment yet. A studio member can shape the brief in a ticket.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const idea = interaction.options.getString("idea", true).trim();
    if (idea.length < 10) {
      await interaction.reply({
        content: "Give the bench a little more: what it does, who uses it, and where it lives.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const draft = await context.ai.brief(idea);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "WRIGHTYARD / THE BENCH" })
        .setTitle("A brief, drafted.")
        .setDescription(truncate(draft, 3_800))
        .setColor(BRAND.colors.brass)
        .setFooter({ text: "Drafted by AI · Check it before sending it to the studio" })
        .setTimestamp();

      const buttons: ButtonBuilder[] = [];
      if (context.config.ticketPanelChannelId) {
        buttons.push(
          new ButtonBuilder()
            .setLabel("Open a ticket")
            .setStyle(ButtonStyle.Link)
            .setURL(channelUrl(context.config.guildId, context.config.ticketPanelChannelId)),
        );
      }
      const site = siteUrl(context.config.siteUrl);
      if (site) {
        buttons.push(
          new ButtonBuilder().setLabel("Website").setStyle(ButtonStyle.Link).setURL(site),
        );
      }

      await interaction.editReply({
        embeds: [embed],
        components:
          buttons.length > 0
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
            : [],
      });
    } catch (error) {
      const message =
        error instanceof AIBusyError
          ? "The AI bench is at capacity. Give it a moment and try again."
          : "The AI bench could not draft that one. Try again, or open a ticket and a person will shape it.";
      await interaction.editReply({ content: message });
    }
  },
} satisfies Command;
