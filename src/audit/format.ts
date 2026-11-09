import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { truncate } from "../format.js";
import type { AuditEvent, AuditField } from "./types.js";

const MAX_TITLE = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;

export interface AuditEmbedData {
  author: string;
  title: string;
  description: string | null;
  color: number;
  fields: AuditField[];
  footer: string;
  timestamp: Date;
}

function actorField(event: AuditEvent): AuditField | null {
  if (!event.actor) {
    return null;
  }
  return {
    name: "Actor",
    value: `${event.actor.tag} (${event.actor.id})`,
    inline: true,
  };
}

function targetField(event: AuditEvent): AuditField | null {
  if (!event.target) {
    return null;
  }
  return {
    name: "Target",
    value: event.target.name
      ? `${event.target.name} (${event.target.id})`
      : event.target.id,
    inline: true,
  };
}

function channelField(event: AuditEvent): AuditField | null {
  if (!event.channelId) {
    return null;
  }
  return {
    name: "Channel",
    value: `<#${event.channelId}>`,
    inline: true,
  };
}

function severityColor(severity: AuditEvent["severity"]): number {
  if (severity === "critical") {
    return BRAND.colors.red;
  }
  if (severity === "warn") {
    return BRAND.colors.brass;
  }
  return BRAND.colors.blue;
}

export function auditEmbedData(event: AuditEvent): AuditEmbedData {
  const fields = [
    actorField(event),
    targetField(event),
    channelField(event),
    ...(event.fields ?? []),
  ]
    .filter((field): field is AuditField => field !== null)
    .slice(0, MAX_FIELDS)
    .map((field) => ({ ...field, value: truncate(field.value, MAX_FIELD_VALUE) }));

  return {
    author: `WRIGHTYARD / AUDIT · ${event.category.toUpperCase()}`,
    title: truncate(event.summary, MAX_TITLE),
    description: null,
    color: severityColor(event.severity),
    fields,
    footer: `${event.id} · ${BRAND.footer}`,
    timestamp: event.createdAt,
  };
}

export function buildAuditEmbed(event: AuditEvent): EmbedBuilder {
  const data = auditEmbedData(event);
  const embed = new EmbedBuilder()
    .setAuthor({ name: data.author })
    .setTitle(data.title)
    .setColor(data.color)
    .setFields(data.fields)
    .setFooter({ text: data.footer })
    .setTimestamp(data.timestamp);

  if (data.description !== null) {
    embed.setDescription(data.description);
  }

  return embed;
}
