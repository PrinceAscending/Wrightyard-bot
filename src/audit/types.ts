import { randomUUID } from "node:crypto";

export type AuditCategory =
  | "message"
  | "member"
  | "server"
  | "voice"
  | "automod"
  | "moderation"
  | "security"
  | "ticket"
  | "command"
  | "lifecycle";

export type AuditSeverity = "info" | "warn" | "critical";

export interface AuditActor {
  id: string;
  tag: string;
}

export interface AuditTarget {
  id: string;
  name?: string;
}

export interface AuditField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface AuditEventInput {
  category: AuditCategory;
  type: string;
  summary: string;
  severity?: AuditSeverity;
  actor?: AuditActor;
  target?: AuditTarget;
  channelId?: string;
  fields?: AuditField[];
  payload?: unknown;
  feed?: boolean;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  guildId: string;
  createdAt: Date;
  severity: AuditSeverity;
  feed: boolean;
}

export interface AuditQuery {
  guildId: string;
  category?: AuditCategory;
  since?: Date;
  limit?: number;
}

export function createAuditEvent(
  input: AuditEventInput,
  guildId: string,
  id: string = randomUUID(),
  now: Date = new Date(),
): AuditEvent {
  return {
    ...input,
    id,
    guildId,
    createdAt: now,
    severity: input.severity ?? "info",
    feed: input.feed ?? true,
    fields: input.fields ? [...input.fields] : undefined,
  };
}
