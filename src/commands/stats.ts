import {
  InteractionContextType,
  MessageFlags,
  Routes,
  SlashCommandBuilder,
  type APIGuild,
} from "discord.js";
import { serializeError } from "../logger.js";
import type { Command } from "../types.js";
import { buildStatsEmbed } from "../views/public.js";

export default {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("The yard by the numbers: people, rooms, roles, boosts, and age.")
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
    const { guild } = interaction;

    let presenceCount: number | null = null;
    try {
      const data = (await context.client.rest.get(Routes.guild(guild.id), {
        query: new URLSearchParams({ with_counts: "true" }),
      })) as APIGuild;
      presenceCount =
        typeof data.approximate_presence_count === "number" ? data.approximate_presence_count : null;
    } catch (error) {
      context.logger.warn("Guild counts could not be fetched; falling back to cached member count.", {
        guildId: guild.id,
        error: serializeError(error),
      });
    }

    await interaction.editReply({
      embeds: [
        buildStatsEmbed({
          guild,
          presenceCount,
          openTickets: context.tickets.openCount,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
} satisfies Command;
