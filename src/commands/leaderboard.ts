import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../types.js";
import { buildLeaderboardEmbed } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("The top of the yard XP ledger.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 10,
  async execute(interaction, context) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "The yard lives in a server. Run this there.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply();
    const entries = await context.levels.getLeaderboard(10);

    await interaction.editReply({
      embeds: [buildLeaderboardEmbed(entries)],
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
