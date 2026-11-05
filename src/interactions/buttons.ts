import {
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import type { BotContext } from "../types.js";
import { TICKET_IDS } from "../tickets/ids.js";
import { replyEphemeral } from "./replies.js";

export async function handleButton(interaction: ButtonInteraction, context: BotContext): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await replyEphemeral(interaction, "The yard lives in a server. Run this there.");
    return;
  }

  if (interaction.guildId !== context.config.guildId) {
    await replyEphemeral(interaction, "This bot serves a different yard.");
    return;
  }

  switch (interaction.customId) {
    case TICKET_IDS.open:
      await context.tickets.open(interaction);
      return;
    case TICKET_IDS.claim:
      await context.tickets.claim(interaction);
      return;
    case TICKET_IDS.close:
      await context.tickets.requestClose(interaction);
      return;
    case TICKET_IDS.confirmClose:
      await context.tickets.confirmClose(interaction);
      return;
    case TICKET_IDS.delete:
      await context.tickets.requestDelete(interaction);
      return;
    case TICKET_IDS.confirmDelete:
      await context.tickets.confirmDelete(interaction);
      return;
    case TICKET_IDS.cancel:
      await context.tickets.cancel(interaction);
      return;
    default:
      if (interaction.customId.startsWith("ticket:")) {
        await replyEphemeral(interaction, "That control is no longer active.");
      } else {
        context.logger.debug("Unknown button interaction ignored", {
          customId: interaction.customId,
          userId: interaction.user.id,
        });
      }
  }
}
