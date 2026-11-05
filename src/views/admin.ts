import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { formatCount, formatDuration, formatTimestamp, truncate } from "../format.js";

export function buildAnnouncement(title: string, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / NOTICE" })
    .setTitle(title)
    .setDescription(message)
    .setColor(BRAND.colors.red)
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}

export interface AdminStatusView {
  readonly version: string;
  readonly nodeVersion: string;
  readonly uptimeSeconds: number;
  readonly ping: number;
  readonly memoryMb: number;
  readonly ready: boolean;
  readonly guilds: number;
  readonly members: number;
  readonly commandsServed: number;
  readonly lastCommandAt: Date | null;
  readonly openTickets: number;
  readonly maintenance: boolean;
  readonly maintenanceSource: string;
  readonly heartbeat: {
    readonly configured: boolean;
    readonly lastAttemptAt: Date | null;
    readonly lastSuccessAt: Date | null;
    readonly lastFailureAt: Date | null;
    readonly lastFailureReason: string | null;
  };
  readonly presence: {
    readonly text: string;
    readonly status: string;
    readonly source: string;
  };
}

export function buildAdminStatus(view: AdminStatusView): EmbedBuilder {
  const heartbeat = view.heartbeat;
  const heartbeatLines = [
    heartbeat.configured ? "Configured" : "Not configured",
    `Last attempt: ${heartbeat.lastAttemptAt ? formatTimestamp(heartbeat.lastAttemptAt, "R") : "never"}`,
    `Last success: ${heartbeat.lastSuccessAt ? formatTimestamp(heartbeat.lastSuccessAt, "R") : "never"}`,
    `Last failure: ${heartbeat.lastFailureAt ? formatTimestamp(heartbeat.lastFailureAt, "R") : "never"}`,
  ];
  if (heartbeat.lastFailureReason) {
    heartbeatLines.push(`Reason: ${heartbeat.lastFailureReason}`);
  }

  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / ENGINE ROOM" })
    .setTitle("Private readings.")
    .setColor(view.maintenance ? BRAND.colors.red : BRAND.colors.blue)
    .addFields(
      {
        name: "Process",
        value: [
          `Version ${view.version} · Node ${view.nodeVersion}`,
          `Uptime ${formatDuration(view.uptimeSeconds)}`,
          `Memory ${view.memoryMb} MB`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Gateway",
        value: [
          view.ready ? "Ready" : "Not ready",
          `Ping ${view.ping >= 0 ? `${Math.round(view.ping)} ms` : "—"}`,
          `${formatCount(view.guilds)} guild${view.guilds === 1 ? "" : "s"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Yard",
        value: [
          `${formatCount(view.members)} members`,
          `${formatCount(view.openTickets)} open tickets`,
          view.maintenance
            ? `Maintenance on${view.maintenanceSource === "website" ? " (website)" : ""}`
            : "Maintenance off",
        ].join("\n"),
        inline: true,
      },
      {
        name: "Servicing",
        value: [
          `${formatCount(view.commandsServed)} commands served`,
          `Last command: ${view.lastCommandAt ? formatTimestamp(view.lastCommandAt, "R") : "never"}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Heartbeat",
        value: heartbeatLines.join("\n"),
        inline: false,
      },
      {
        name: "Presence",
        value: [
          `Text: ${truncate(view.presence.text, 128)}`,
          `Status: ${view.presence.status}`,
          `Source: ${view.presence.source}`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}
