import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type RepliableInteraction,
} from "discord.js";
import { serializeError } from "../logger.js";
import { isOwner } from "../permissions.js";
import type { BotContext } from "../types.js";
import { handleButton } from "./buttons.js";

const GENERIC_FAILURE = "Something went wrong on our side. The error is logged; try again in a moment.";

export async function handleInteraction(interaction: Interaction, context: BotContext): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, context);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction, context);
    }
  } catch (error) {
    context.logger.error("Interaction failed", {
      interactionId: interaction.id,
      interactionType: interaction.type,
      userId: interaction.user?.id,
      guildId: interaction.guildId,
      error: serializeError(error),
    });
    await respondWithFailure(interaction);
  }
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "The yard lives in a server. Run this there.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (interaction.guildId !== context.config.guildId) {
    await interaction.reply({
      content: "This bot serves a different yard.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const command = context.commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({
      content: "That command is not available. Try /help for the current index.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (command.ownerOnly && !isOwner(interaction.user.id, context.config)) {
    await interaction.reply({
      content: "Owner only.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
  const remaining = context.cooldowns.remainingMs(cooldownKey);
  if (remaining > 0) {
    await interaction.reply({
      content: `Give it a moment. Try again in ${Math.ceil(remaining / 1000)}s.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  context.cooldowns.start(cooldownKey, command.cooldownSeconds ?? 3);
  context.state.recordCommand();

  const startedAt = Date.now();
  try {
    await command.execute(interaction, context);
    context.logger.info("Command served", {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    context.logger.error("Command failed", {
      command: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      durationMs: Date.now() - startedAt,
      error: serializeError(error),
    });
    await respondWithFailure(interaction);
  }
}

async function respondWithFailure(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  await replyWithFailure(interaction);
}

async function replyWithFailure(interaction: RepliableInteraction): Promise<void> {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: GENERIC_FAILURE, allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.replied) {
      await interaction.followUp({
        content: GENERIC_FAILURE,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({
      content: GENERIC_FAILURE,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch {
    // The interaction token may be expired. Nothing useful to say.
  }
}
