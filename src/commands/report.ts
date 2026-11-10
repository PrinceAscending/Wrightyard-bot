import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../types.js";

export default {
  data: new SlashCommandBuilder()
    .setName("report")
    .setDescription("Report a member to the studio staff.")
    .setDMPermission(false)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("The member you are reporting.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("What happened, and when.")
        .setMinLength(1)
        .setMaxLength(1_500)
        .setRequired(true),
    ),
  cooldownSeconds: 60,
  async execute(interaction, context) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "The yard lives in a server. Run this there.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const runtime = context.runtime;
    if (!runtime) {
      await interaction.reply({
        content: "Staff services are not ready.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const target = interaction.options.getMember("member");
    if (!target) {
      await interaction.reply({
        content: "Pick a member who is still in this server.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (target.id === interaction.user.id) {
      await interaction.reply({
        content: "You cannot report yourself.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    try {
      const record = await runtime.staff.report(
        interaction.member,
        target,
        interaction.options.getString("reason", true),
      );
      await interaction.reply({
        content: `Report filed as case #${String(record.caseId).padStart(4, "0")}. Staff will review it.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      context.logger.warn("Report failed", {
        userId: interaction.user.id,
        targetId: target.id,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      await interaction.reply({
        content: "The report did not go through. Try again in a moment.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  },
} satisfies Command;
