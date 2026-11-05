import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { isOwner } from "../permissions.js";
import type { Command } from "../types.js";
import {
  runAdminStatus,
  runAnnounce,
  runMaintenance,
  runPresence,
  runSync,
  runTicketPanel,
} from "../admin/actions.js";

const data = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("Studio controls. Wrightyard owner only.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("Private process, presence, and heartbeat readings."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("announce")
      .setDescription("Post a notice in the announcements channel.")
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("The notice title.")
          .setMinLength(1)
          .setMaxLength(100)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("The notice body.")
          .setMinLength(1)
          .setMaxLength(1800)
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Where to post. Defaults to the announcements channel.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("presence")
      .setDescription("Set a local presence override.")
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("The status text, up to 128 characters.")
          .setMinLength(1)
          .setMaxLength(128)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("status")
          .setDescription("The dot colour.")
          .addChoices(
            { name: "Online", value: "online" },
            { name: "Idle", value: "idle" },
            { name: "Do not disturb", value: "dnd" },
            { name: "Invisible", value: "invisible" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("maintenance")
      .setDescription("Shut the gate and mark the yard idle.")
      .addBooleanOption((option) =>
        option.setName("enabled").setDescription("Turn maintenance on or off.").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("sync").setDescription("Re-register slash commands in this guild."),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("ticketpanel").setDescription("Post or refresh the ticket panel."),
  );

export default {
  data,
  cooldownSeconds: 2,
  ownerOnly: true,
  async execute(interaction, context) {
    if (!isOwner(interaction.user.id, context.config)) {
      await interaction.reply({
        content: "Owner only.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    switch (subcommand) {
      case "status":
        await runAdminStatus(interaction, context);
        return;
      case "announce":
        await runAnnounce(interaction, context);
        return;
      case "presence":
        await runPresence(interaction, context);
        return;
      case "maintenance":
        await runMaintenance(interaction, context);
        return;
      case "sync":
        await runSync(interaction, context);
        return;
      case "ticketpanel":
        await runTicketPanel(interaction, context);
        return;
      default:
        await interaction.reply({
          content: "Unknown admin subcommand.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
    }
  },
} satisfies Command;
