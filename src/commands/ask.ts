import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { BRAND } from "../brand.js";
import { AIBusyError } from "../services/ai.js";
import type { Command } from "../types.js";
import { siteButtonRows } from "../views/public.js";

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the yard about the studio, its services, or how a job starts.")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("What do you want to know?")
        .setMaxLength(800)
        .setRequired(true),
    ),
  cooldownSeconds: 12,
  async execute(interaction, context) {
    if (!context.ai.enabled) {
      await interaction.reply({
        content: "The AI bench is not wired on this deployment yet. A studio member can answer in a ticket.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const question = interaction.options.getString("question", true).trim();
    if (question.length < 3) {
      await interaction.reply({
        content: "Give the bench a full question.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply();

    try {
      const answer = await context.ai.ask(question);
      const embed = new EmbedBuilder()
        .setAuthor({ name: "WRIGHTYARD / THE BENCH" })
        .setTitle("A reading from the bench.")
        .setDescription(truncate(answer, 3_800))
        .setColor(BRAND.colors.blue)
        .addFields({
          name: "The question",
          value: truncate(question, 1_000),
        })
        .setFooter({ text: "Drafted by AI · Verify the details with the studio" })
        .setTimestamp();

      await interaction.editReply({
        embeds: [embed],
        components: siteButtonRows(context.config.siteUrl),
      });
    } catch (error) {
      const message =
        error instanceof AIBusyError
          ? "The AI bench is at capacity. Give it a moment and ask again."
          : "The AI bench could not answer that one. Try again, or open a ticket and a person will pick it up.";
      await interaction.editReply({ content: message });
    }
  },
} satisfies Command;
