import { MessageFlags, type InteractionEditReplyOptions, type RepliableInteraction } from "discord.js";

export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  } catch {
    // The token may have expired or the channel may be gone. Nothing useful to say.
  }
}

export async function editReplySafe(
  interaction: RepliableInteraction,
  options: string | InteractionEditReplyOptions,
): Promise<void> {
  try {
    await interaction.editReply(options);
  } catch {
    // The interaction token may have expired. The server log already has the cause.
  }
}
