import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { truncate } from "../format.js";

export interface SecurityAlertView {
  readonly ownerId: string;
  readonly heading: string;
  readonly rule: string | null;
  readonly count: number;
  readonly windowSeconds: number | null;
  readonly actorId: string;
  readonly actorTag: string;
  readonly action: string;
  readonly caseId?: number;
  readonly guildId: string;
  readonly channelId?: string | null;
}

function caseNumber(value: number): string {
  return `#${String(value).padStart(4, "0")}`;
}

/**
 * Owner-facing anti-nuke alert. The description begins with the owner mention
 * so the security batch's explicit `allowedMentions` can produce a real ping.
 */
export function buildSecurityAlert(view: SecurityAlertView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / SECURITY" })
    .setTitle(truncate(view.heading, 256))
    .setDescription(
      [
        `<@${view.ownerId}>`,
        "The anti-nuke guard recorded a destructive pattern. The audit ledger has the full trail.",
      ].join("\n"),
    )
    .setColor(view.action === "alert" ? BRAND.colors.brass : BRAND.colors.red)
    .addFields(
      {
        name: "Actor",
        value: `${view.actorTag} (${view.actorId})`,
        inline: true,
      },
      { name: "Action", value: view.action, inline: true },
      {
        name: "Rule",
        value: view.rule ?? "none",
        inline: true,
      },
      { name: "Count", value: String(view.count), inline: true },
      {
        name: "Window",
        value: view.windowSeconds === null ? "n/a" : `${view.windowSeconds}s`,
        inline: true,
      },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp();

  if (view.caseId !== undefined) {
    embed.addFields({ name: "Case", value: caseNumber(view.caseId), inline: true });
  }
  if (view.channelId) {
    embed.addFields({
      name: "Channel",
      value: `https://discord.com/channels/${view.guildId}/${view.channelId}`,
    });
  }

  return embed;
}
