import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { isOwner } from "../permissions.js";
import { resolveStaffRank } from "../staff/ranks.js";
import type { Command } from "../types.js";
import { buildHelpEmbed } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("The short index of everything this bot can do.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 5,
  async execute(interaction, context) {
    const isStaff = resolveStaffRank(interaction.member, context.config) !== "none";
    await interaction.reply({
      embeds: [buildHelpEmbed(isOwner(interaction.user.id, context.config), isStaff)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
