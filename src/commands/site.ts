import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../types.js";
import { buildSiteEmbed, siteButtonRows } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("site")
    .setDescription("Links to the studio, dashboard, and status page.")
    .setContexts(InteractionContextType.Guild),
  cooldownSeconds: 5,
  async execute(interaction, context) {
    const site = context.config.siteUrl;
    if (!site) {
      await interaction.reply({
        content: "The website address is not configured on this deployment yet.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({
      embeds: [buildSiteEmbed(site)],
      components: siteButtonRows(site),
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
