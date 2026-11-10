import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { Command } from "../types.js";
import type { Runtime } from "../runtime.js";
import { StaffGuardError, parseDuration } from "../staff/actions.js";
import type { StaffChannelLike } from "../staff/channels.js";
import { atLeast, resolveStaffRank, type StaffRank } from "../staff/ranks.js";
import { buildStaffStats } from "../staff/stats.js";
import {
  buildCaseEmbed,
  buildNotesEmbed,
  buildStaffStatsEmbed,
  buildWarningsEmbed,
} from "../views/staff.js";

/**
 * `moderator` is the floor for day-to-day work; `steward` owns irreversible
 * actions (bans, unbans, clearing the warning ledger).
 */
export const STAFF_SUBCOMMAND_RANK: Record<string, StaffRank> = {
  warn: "moderator",
  warnings: "moderator",
  clearwarnings: "steward",
  timeout: "moderator",
  untimeout: "moderator",
  kick: "moderator",
  ban: "steward",
  unban: "steward",
  purge: "moderator",
  lock: "moderator",
  unlock: "moderator",
  slowmode: "moderator",
  note: "moderator",
  notes: "moderator",
  case: "moderator",
  history: "moderator",
  stats: "moderator",
  duty: "moderator",
};

const ACCEPTED_DURATION = "Duration like 10m, 1h, or 7d (maximum 28 days).";

function targetMember(interaction: ChatInputCommandInteraction<"cached">): GuildMember {
  const member = interaction.options.getMember("member");
  if (!member) {
    throw new Error("Pick a member who is still in this server.");
  }
  return member;
}

function reason(
  interaction: ChatInputCommandInteraction<"cached">,
  name = "reason",
): string {
  return interaction.options.getString(name, true);
}

function caseNumber(caseId: number): string {
  return `#${String(caseId).padStart(4, "0")}`;
}

export function parseCaseId(raw: string): number {
  const normalized = raw.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Case IDs look like #0001 or 1.");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Case IDs look like #0001 or 1.");
  }
  return value;
}

function actionChannel(
  interaction: ChatInputCommandInteraction,
  optionName = "channel",
): StaffChannelLike {
  const channel = interaction.options.getChannel(optionName) ?? interaction.channel;
  if (!channel) {
    throw new Error("That action needs a text channel.");
  }
  return channel as unknown as StaffChannelLike;
}

function currentChannel(interaction: ChatInputCommandInteraction): StaffChannelLike {
  if (!interaction.channel) {
    throw new Error("That action needs a text channel.");
  }
  return interaction.channel as unknown as StaffChannelLike;
}

function errorContent(error: unknown): string {
  if (error instanceof StaffGuardError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.name === "Error") {
      return error.message;
    }
    return `${error.name}. The action did not complete; the error is logged.`;
  }
  return "The action did not complete; the error is logged.";
}

async function handle(
  interaction: ChatInputCommandInteraction<"cached">,
  runtime: Runtime,
  actor: GuildMember,
  subcommand: string,
): Promise<InteractionEditReplyOptions> {
  switch (subcommand) {
    case "warn": {
      const record = await runtime.staff.warn(actor, targetMember(interaction), reason(interaction));
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "warnings": {
      const target = targetMember(interaction);
      const cases = await runtime.staff.listWarnings(target);
      return {
        embeds: [buildWarningsEmbed({ id: target.id, tag: target.user.username }, cases)],
      };
    }
    case "clearwarnings": {
      const record = await runtime.staff.clearWarnings(
        actor,
        targetMember(interaction),
        reason(interaction),
      );
      const cleared = Array.isArray(record.metadata.cleared) ? record.metadata.cleared.length : 0;
      return {
        content: `Cleared ${cleared} warning${cleared === 1 ? "" : "s"} · case ${caseNumber(record.caseId)}.`,
      };
    }
    case "timeout": {
      const durationMs = parseDuration(interaction.options.getString("duration", true));
      if (durationMs === null) {
        throw new Error(`That duration is not valid. ${ACCEPTED_DURATION}`);
      }
      const record = await runtime.staff.timeout(
        actor,
        targetMember(interaction),
        durationMs,
        reason(interaction),
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "untimeout": {
      const record = await runtime.staff.untimeout(
        actor,
        targetMember(interaction),
        reason(interaction),
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "kick": {
      const record = await runtime.staff.kick(
        actor,
        targetMember(interaction),
        reason(interaction),
        interaction.options.getBoolean("notify") ?? true,
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "ban": {
      const days = interaction.options.getInteger("delete_messages") ?? 0;
      const record = await runtime.staff.ban(
        actor,
        targetMember(interaction),
        reason(interaction),
        days * 86_400,
        interaction.options.getBoolean("notify") ?? true,
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "unban": {
      const record = await runtime.staff.unban(
        actor,
        interaction.options.getString("user_id", true),
        reason(interaction),
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "purge": {
      const user = interaction.options.getUser("member");
      const result = await runtime.staffChannels.purge(
        actor,
        currentChannel(interaction),
        interaction.options.getInteger("count", true),
        {
          ...(user ? { memberId: user.id } : {}),
          ...(interaction.options.getString("contains")
            ? { contains: interaction.options.getString("contains", true) }
            : {}),
        },
      );
      const skipped =
        result.skipped > 0 ? ` ${result.skipped} skipped as older than 14 days.` : "";
      return {
        content: `Purged ${result.deletedIds.length} message${result.deletedIds.length === 1 ? "" : "s"}.${skipped}`,
      };
    }
    case "lock": {
      const record = await runtime.staffChannels.lock(actor, actionChannel(interaction));
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "unlock": {
      const record = await runtime.staffChannels.unlock(actor, actionChannel(interaction));
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "slowmode": {
      const record = await runtime.staffChannels.slowmode(
        actor,
        actionChannel(interaction),
        interaction.options.getInteger("seconds", true),
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "note": {
      const record = await runtime.staff.note(
        actor,
        targetMember(interaction),
        reason(interaction, "text"),
      );
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "notes": {
      const target = targetMember(interaction);
      const notes = await runtime.staff.listNotes(target);
      return {
        embeds: [buildNotesEmbed({ id: target.id, tag: target.user.username }, notes)],
      };
    }
    case "case": {
      const caseId = parseCaseId(interaction.options.getString("case_id", true));
      const action = interaction.options.getString("action", true);
      if (action === "resolve") {
        const record = await runtime.staff.resolveCase(actor, caseId);
        return { embeds: [buildCaseEmbed(record)] };
      }
      const record = await runtime.cases.get(interaction.guildId, caseId);
      if (!record) {
        throw new Error(`Case ${caseNumber(caseId)} was not found.`);
      }
      return { embeds: [buildCaseEmbed(record)] };
    }
    case "history": {
      const user = interaction.options.getUser("member", true);
      const records = await runtime.cases.list(interaction.guildId, {
        targetId: user.id,
        limit: 10,
      });
      if (records.length === 0) {
        return { content: `No cases on file for ${user.username}.` };
      }
      return { embeds: records.map((record) => buildCaseEmbed(record)) };
    }
    case "stats": {
      const user = interaction.options.getUser("member") ?? interaction.user;
      const days = interaction.options.getInteger("days") ?? 30;
      const stats = await buildStaffStats({
        moderatorId: user.id,
        cases: runtime.cases,
        duty: runtime.duty,
        days,
        guildId: interaction.guildId,
      });
      return {
        embeds: [
          buildStaffStatsEmbed({
            ...stats,
            moderatorId: user.id,
            moderatorTag: user.username,
          }),
        ],
      };
    }
    case "duty": {
      const state = interaction.options.getString("state", true);
      if (state === "on") {
        const session = await runtime.duty.start(interaction.guildId, actor.id);
        return { content: `Duty started ${session.startedAt.toISOString()}.` };
      }
      const session = await runtime.duty.stop(interaction.guildId, actor.id);
      return {
        content: session ? "Duty stopped. The ledger is updated." : "No open duty session.",
      };
    }
    default:
      throw new Error("Unknown staff subcommand.");
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Staff moderation: warn, timeout, kick, ban, and the case ledger.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("warn")
        .setDescription("Warn a member and open a case.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to warn.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why this warning is being issued.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("warnings")
        .setDescription("List a member's active warnings.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to check.").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("clearwarnings")
        .setDescription("Revoke every active warning for a member.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to clear.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why the warnings are being cleared.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("timeout")
        .setDescription("Apply a Discord timeout and open a case.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to time out.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription(ACCEPTED_DURATION)
            .setMinLength(2)
            .setMaxLength(10)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why this timeout is being applied.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("untimeout")
        .setDescription("Remove a member's timeout.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to release.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why the timeout is being removed.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("kick")
        .setDescription("Kick a member and open a case.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to kick.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why this member is being kicked.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName("notify")
            .setDescription("Send the member a DM before the kick. Defaults to true."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ban")
        .setDescription("Ban a member and open a case.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to ban.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why this member is being banned.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("delete_messages")
            .setDescription("Days of messages to delete (0-7). Defaults to 0.")
            .setMinValue(0)
            .setMaxValue(7),
        )
        .addBooleanOption((option) =>
          option
            .setName("notify")
            .setDescription("Send the member a DM before the ban. Defaults to true."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("unban")
        .setDescription("Remove a ban and close the open case.")
        .addStringOption((option) =>
          option
            .setName("user_id")
            .setDescription("The Discord user ID to unban.")
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why this ban is being lifted.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("purge")
        .setDescription("Bulk delete up to 100 recent messages.")
        .addIntegerOption((option) =>
          option
            .setName("count")
            .setDescription("How many recent messages to scan (1-100).")
            .setMinValue(1)
            .setMaxValue(100)
            .setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("member").setDescription("Only delete messages from this user."),
        )
        .addStringOption((option) =>
          option
            .setName("contains")
            .setDescription("Only delete messages containing this text.")
            .setMaxLength(200),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("lock")
        .setDescription("Deny Send Messages for everyone in a channel.")
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Channel to lock. Defaults to this one."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("unlock")
        .setDescription("Remove the everyone Send Messages deny.")
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Channel to unlock. Defaults to this one."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("slowmode")
        .setDescription("Set a channel's slowmode.")
        .addIntegerOption((option) =>
          option
            .setName("seconds")
            .setDescription("Seconds between messages (0-21600).")
            .setMinValue(0)
            .setMaxValue(21_600)
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Channel to update. Defaults to this one."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("note")
        .setDescription("Add a private note to a member's ledger.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member this note is about.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription("The note text.")
            .setMinLength(1)
            .setMaxLength(1_500)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("notes")
        .setDescription("List a member's private notes.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to check.").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("case")
        .setDescription("View or resolve a case.")
        .addStringOption((option) =>
          option
            .setName("case_id")
            .setDescription("The case number, like #0001 or 1.")
            .setMinLength(1)
            .setMaxLength(10)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("View the case or resolve it.")
            .addChoices({ name: "View", value: "view" }, { name: "Resolve", value: "resolve" })
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("history")
        .setDescription("List the latest cases for a member.")
        .addUserOption((option) =>
          option.setName("member").setDescription("The member to check.").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("Action counts and duty minutes for a staff member.")
        .addUserOption((option) =>
          option.setName("member").setDescription("Staff member. Defaults to you."),
        )
        .addIntegerOption((option) =>
          option
            .setName("days")
            .setDescription("Window in days (1-365). Defaults to 30.")
            .setMinValue(1)
            .setMaxValue(365),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("duty")
        .setDescription("Start or stop a duty session.")
        .addStringOption((option) =>
          option
            .setName("state")
            .setDescription("Clock on or off.")
            .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })
            .setRequired(true),
        ),
    ),
  cooldownSeconds: 2,
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

    const subcommand = interaction.options.getSubcommand(true);
    const minimum = STAFF_SUBCOMMAND_RANK[subcommand] ?? "moderator";
    const rank = resolveStaffRank(interaction.member, context.config);
    if (!atLeast(rank, minimum)) {
      await interaction.reply({
        content: `You need ${minimum} rank or higher for /staff ${subcommand}.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const payload = await handle(interaction, runtime, interaction.member, subcommand);
      await interaction.editReply(payload);
    } catch (error) {
      context.logger.warn("Staff command failed", {
        subcommand,
        userId: interaction.user.id,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      await interaction.editReply({
        content: errorContent(error),
        allowedMentions: { parse: [] },
      });
    }
  },
} satisfies Command;
