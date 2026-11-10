import type { AuditEventInput } from "./types.js";

export interface CommandAuditInput {
  readonly command: string;
  readonly userId: string;
  readonly guildId: string;
  readonly durationMs: number;
  readonly error?: unknown;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error === "string" ? "Error" : "UnknownError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function commandAuditEvent(input: CommandAuditInput): AuditEventInput {
  const failed = input.error !== undefined;
  return {
    category: "command",
    type: failed ? "command.failed" : "command.served",
    summary: failed
      ? `Command /${input.command} failed (${errorName(input.error)})`
      : `Command /${input.command} served`,
    severity: failed ? "warn" : "info",
    feed: false,
    actor: { id: input.userId, tag: input.userId },
    fields: [
      { name: "Command", value: `/${input.command}`, inline: true },
      { name: "Duration", value: `${input.durationMs}ms`, inline: true },
      { name: "Guild", value: input.guildId, inline: true },
      ...(failed
        ? [
            { name: "Error", value: `${errorName(input.error)}: ${errorMessage(input.error)}` },
          ]
        : []),
    ],
    payload: { guildId: input.guildId },
  };
}
