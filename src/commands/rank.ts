import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../types.js";
import { buildRankEmbed } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Your yard level, XP, message count, and standing.")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Whose rank to read. Defaults to you.")
        .setRequired(false),
    ),
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

    await interaction.deferReply();

    const target = interaction.options.getMember("member") ?? interaction.member;
    const record = await context.levels.getRecord(target.id);

    if (!record) {
      await interaction.editReply({
        content: `${target} has no XP yet. The ledger starts at the first message in the yard.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const rank = await context.levels.getRank(target.id);
    await interaction.editReply({
      embeds: [buildRankEmbed({ member: target, record, rank })],
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
