import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { truncate } from "../format.js";
import type { SecurityDecision } from "../security/rules.js";

export interface SecurityStatusView {
  readonly enabled: boolean;
  readonly mode: string;
  readonly ruleCount: number;
  readonly raidMode: boolean;
  readonly snapshotAge: string;
  readonly auditStore: string;
  readonly caseStore: string;
  readonly lastAlert: string | null;
}

export interface SecuritySimulationView {
  readonly kind: string;
  readonly mode: string;
  readonly decision: SecurityDecision;
}

function modeLabel(view: SecurityStatusView): string {
  if (!view.enabled) {
    return "disarmed";
  }
  return view.mode;
}

/**
 * Staff-facing security dashboard. Every value is passed in so the command can
 * source it from the live runtime without this view importing the service graph.
 */
export function buildSecurityStatus(view: SecurityStatusView): EmbedBuilder {
  const thresholds = `${view.ruleCount} rules`;
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / SECURITY" })
    .setTitle("Yard watch")
    .setColor(view.enabled ? BRAND.colors.brass : BRAND.colors.ink)
    .addFields(
      {
        name: "Anti-nuke",
        value: `${modeLabel(view)} · ${thresholds}`,
        inline: true,
      },
      {
        name: "Raid guard",
        value: view.raidMode ? "Active — joins contained" : "Standing by",
        inline: true,
      },
      {
        name: "Snapshot",
        value: view.snapshotAge,
        inline: true,
      },
      {
        name: "Stores",
        value: `archive ${view.auditStore} · cases ${view.caseStore}`,
        inline: true,
      },
      {
        name: "Last alert",
        value: view.lastAlert ?? "No alerts since startup",
        inline: true,
      },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}

/** Read-only preview of what a burst would trigger; never performs enforcement. */
export function buildSecuritySimulation(view: SecuritySimulationView): EmbedBuilder {
  const rule = view.decision.rule;
  const thresholds = rule
    ? `alert ${rule.alertAt} · quarantine ${rule.quarantineAt} · ban ${rule.banAt}`
    : "no rule";
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / SECURITY" })
    .setTitle(truncate(`Simulation: ${view.kind}`, 256))
    .setColor(view.decision.action === "none" ? BRAND.colors.blue : BRAND.colors.red)
    .setDescription("Simulation only. No member was quarantined, banned, or restored.")
    .addFields(
      {
        name: "Mode",
        value: view.mode,
        inline: true,
      },
      {
        name: "Synthetic decision",
        value: view.decision.action,
        inline: true,
      },
      {
        name: "Burst",
        value: `${view.decision.count} × ${view.decision.kind ?? view.kind}`,
        inline: true,
      },
      {
        name: "Thresholds",
        value: thresholds,
      },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}
