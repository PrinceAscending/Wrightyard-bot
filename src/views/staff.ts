import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { formatDuration, formatTimestamp, truncate } from "../format.js";
import type { ModerationCase } from "../staff/cases.js";

const ACTION_LABEL: Record<ModerationCase["action"], string> = {
  warn: "Warning",
  timeout: "Timeout",
  untimeout: "Timeout removed",
  kick: "Kick",
  ban: "Ban",
  unban: "Unban",
  purge: "Purge",
  lock: "Channel locked",
  unlock: "Channel unlocked",
  slowmode: "Slowmode",
  note: "Note",
  warnClear: "Warnings cleared",
  caseResolve: "Case resolved",
  report: "Report",
  quarantine: "Quarantine",
  securityBan: "Security ban",
};

function caseNumber(value: number): string {
  return `#${String(value).padStart(4, "0")}`;
}

function colorFor(record: ModerationCase): number {
  if (
    record.action === "ban" ||
    record.action === "kick" ||
    record.action === "securityBan" ||
    record.action === "quarantine"
  ) {
    return BRAND.colors.red;
  }
  if (record.status === "revoked" || record.status === "expired") {
    return BRAND.colors.blue;
  }
  return BRAND.colors.brass;
}

export function buildCaseEmbed(record: ModerationCase): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / MODERATION" })
    .setTitle(`${caseNumber(record.caseId)} · ${ACTION_LABEL[record.action]}`)
    .setColor(colorFor(record))
    .addFields(
      {
        name: "Target",
        value: record.targetTag
          ? `${record.targetTag} (${record.targetId ?? "unknown"})`
          : record.targetId ?? "unknown",
        inline: true,
      },
      {
        name: "Moderator",
        value: record.moderatorTag
          ? `${record.moderatorTag} (${record.moderatorId})`
          : record.moderatorId,
        inline: true,
      },
      { name: "Status", value: record.status, inline: true },
    )
    .setFooter({ text: BRAND.footer });

  if (record.reason) {
    embed.addFields({ name: "Reason", value: truncate(record.reason, 1_024) });
  }
  if (record.durationMs) {
    embed.addFields({
      name: "Duration",
      value: formatDuration(record.durationMs / 1_000),
      inline: true,
    });
  }
  if (record.expiresAt) {
    embed.addFields({
      name: "Expires",
      value: formatTimestamp(record.expiresAt),
      inline: true,
    });
  }
  embed.addFields({
    name: "Created",
    value: formatTimestamp(record.createdAt),
    inline: true,
  });

  return embed;
}

export interface WarningTarget {
  readonly id: string;
  readonly tag?: string;
}

export function buildWarningsEmbed(
  target: WarningTarget,
  cases: readonly ModerationCase[],
): EmbedBuilder {
  const description =
    cases.length === 0
      ? "No active warnings. The ledger is clear."
      : cases
          .map(
            (record) =>
              `**${caseNumber(record.caseId)}** · ${formatTimestamp(record.createdAt, "d")} · ${truncate(
                record.reason || "No reason provided",
                200,
              )}`,
          )
          .join("\n");

  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / MODERATION" })
    .setTitle(`Warnings · ${target.tag ?? target.id}`)
    .setDescription(description)
    .setColor(cases.length > 0 ? BRAND.colors.brass : BRAND.colors.blue)
    .setFooter({ text: `${cases.length} active warning${cases.length === 1 ? "" : "s"} · ${BRAND.footer}` });
}
