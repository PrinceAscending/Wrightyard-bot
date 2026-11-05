import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { isOwner } from "../permissions.js";
import type { Command } from "../types.js";
import { buildHelpEmbed } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("The short index of everything this bot can do.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 5,
  async execute(interaction, context) {
    await interaction.reply({
      embeds: [buildHelpEmbed(isOwner(interaction.user.id, context.config))],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
