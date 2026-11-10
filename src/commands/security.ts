import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { BRAND } from "../brand.js";
import { formatDuration, formatTimestamp } from "../format.js";
import type { Command } from "../types.js";
import type { Runtime } from "../runtime.js";
import { evaluateSecurity, SECURITY_RULES, type SecurityRule } from "../security/rules.js";
import type { DestructiveKind, ObservedAction } from "../security/types.js";
import { atLeast, resolveStaffRank } from "../staff/ranks.js";
import {
  buildSecuritySimulation,
  buildSecurityStatus,
  type SecurityStatusView,
} from "../views/security-status.js";

const SIMULATED_ACTOR_ID = "simulation";
const SIMULATED_ACTOR_TAG = "simulation";

const DESTRUCTIVE_KINDS: readonly DestructiveKind[] = [
  "channelDelete",
  "roleDelete",
  "ban",
  "kick",
  "webhookCreate",
  "channelCreate",
  "roleCreate",
  "memberRoleUpdate",
  "emojiDelete",
  "stickerDelete",
  "inviteCreate",
  "guildUpdate",
  "bulkDelete",
  "threadDelete",
];

function storeLabel(durable: boolean): string {
  return durable ? "mongodb" : "json";
}

function snapshotAge(capturedAt: Date | null, now: Date): string {
  if (!capturedAt) {
    return "No snapshot yet";
  }
  return `${formatDuration((now.getTime() - capturedAt.getTime()) / 1_000)} ago`;
}

function statusView(runtime: Runtime, now: Date): SecurityStatusView {
  const security = runtime.security.snapshot();
  return {
    enabled: security.enabled,
    mode: security.mode,
    ruleCount: security.ruleCount,
    raidMode: runtime.raid.snapshot().active,
    snapshotAge: snapshotAge(runtime.snapshots.last()?.capturedAt ?? null, now),
    auditStore: storeLabel(runtime.auditStore.durable),
    caseStore: storeLabel(runtime.cases.durable),
    lastAlert: security.lastAlertAt ? formatTimestamp(security.lastAlertAt, "R") : null,
  };
}

function ruleFor(kind: DestructiveKind): SecurityRule {
  const rule = SECURITY_RULES.find((entry) => entry.kind === kind);
  if (!rule) {
    throw new Error(`No security rule exists for ${kind}.`);
  }
  return rule;
}

/**
 * Builds a burst at the rule's ban threshold so the preview shows the strongest
 * response the configured mode allows. The actions never reach the security
 * service, so nothing is enforced.
 */
function simulateBurst(
  kind: DestructiveKind,
  now: Date,
  mode: "alert" | "quarantine" | "ban",
): ReturnType<typeof evaluateSecurity> {
  const rule = ruleFor(kind);
  const actions: ObservedAction[] = Array.from({ length: rule.banAt }, (_, index) => ({
    kind,
    guildId: "simulation",
    actorId: SIMULATED_ACTOR_ID,
    actorTag: SIMULATED_ACTOR_TAG,
    targetId: null,
    targetName: null,
    at: new Date(now.getTime() - index * 1_000),
  }));
  return evaluateSecurity(actions, now, mode);
}

async function replyNotReady(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: "Security services are not ready.",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("security")
    .setDescription("Anti-nuke, raid, and snapshot controls. Wrightyard owner only.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Read the anti-nuke mode, raid state, snapshot age, and stores."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("raid")
        .setDescription("Open or close the raid window by hand.")
        .addStringOption((option) =>
          option
            .setName("state")
            .setDescription("Whether the raid guard should contain joins.")
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("snapshot")
        .setDescription("Capture a restorable guild snapshot right now."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("simulate")
        .setDescription("Preview the decision a destructive burst would trigger. No enforcement.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("The destructive action to simulate.")
            .setRequired(true)
            .addChoices(
              ...DESTRUCTIVE_KINDS.map((kind) => ({ name: kind, value: kind })),
            ),
        ),
    ),
  cooldownSeconds: 2,
  async execute(interaction, context) {
    const runtime = context.runtime;
    if (!runtime) {
      await replyNotReady(interaction);
      return;
    }

    const rank = resolveStaffRank(interaction.member, context.config);
    if (!atLeast(rank, "founder")) {
      await interaction.reply({
        content: "Only the Wrightyard owner can use /security.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "status") {
      await interaction.reply({
        embeds: [buildSecurityStatus(statusView(runtime, new Date()))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "raid") {
      const state = interaction.options.getString("state", true);
      await runtime.raid.setActive(state === "on", `requested by ${interaction.user.tag}`);
      await interaction.reply({
        embeds: [buildSecurityStatus(statusView(runtime, new Date()))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "snapshot") {
      const snapshot = await runtime.snapshots.captureNow();
      const embed = new EmbedBuilder()
        .setAuthor({ name: "WRIGHTYARD / SECURITY" })
        .setTitle("Snapshot captured")
        .setColor(BRAND.colors.blue)
        .addFields(
          { name: "Roles", value: String(snapshot.roles.length), inline: true },
          { name: "Channels", value: String(snapshot.channels.length), inline: true },
          {
            name: "Captured",
            value: formatTimestamp(snapshot.capturedAt, "T"),
            inline: true,
          },
        )
        .setFooter({ text: BRAND.footer })
        .setTimestamp();
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const kind = interaction.options.getString("action", true) as DestructiveKind;
    const now = new Date();
    const decision = simulateBurst(kind, now, context.config.antiNukeMode);
    const rule = ruleFor(kind);

    runtime.audit.record({
      category: "security",
      type: "security.alert",
      summary: `Simulated ${kind} burst — ${decision.action}`,
      severity: "info",
      actor: { id: interaction.user.id, tag: interaction.user.tag },
      fields: [
        { name: "Simulated", value: "yes", inline: true },
        { name: "Decision", value: decision.action, inline: true },
        {
          name: "Thresholds",
          value: `alert ${rule.alertAt} · quarantine ${rule.quarantineAt} · ban ${rule.banAt}`,
        },
      ],
      payload: {
        simulated: true,
        kind,
        mode: context.config.antiNukeMode,
        decision: {
          action: decision.action,
          kind: decision.kind,
          count: decision.count,
          rule: decision.rule?.kind ?? null,
        },
      },
      feed: true,
    });

    await interaction.reply({
      embeds: [
        buildSecuritySimulation({
          kind,
          mode: context.config.antiNukeMode,
          decision,
        }),
      ],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
} as Command;
