import type { AuditEventInput } from "./types.js";

export type TicketAction = "open" | "claim" | "close" | "delete";

export interface TicketAuditInput {
  readonly action: TicketAction;
  readonly ticketNumber: number;
  readonly channelId: string;
  readonly actorId: string;
  readonly openerId: string;
}

const VERBS: Record<TicketAction, string> = {
  open: "opened",
  claim: "claimed",
  close: "closed",
  delete: "deleted",
};

export function ticketAuditEvent(input: TicketAuditInput): AuditEventInput {
  return {
    category: "ticket",
    type: `ticket.${input.action}`,
    summary: `Ticket #${input.ticketNumber} ${VERBS[input.action]}`,
    severity: input.action === "delete" ? "warn" : "info",
    actor: { id: input.actorId, tag: input.actorId },
    target: { id: input.channelId },
    channelId: input.channelId,
    fields: [
      { name: "Ticket", value: `#${input.ticketNumber}`, inline: true },
      { name: "Channel", value: `<#${input.channelId}>`, inline: true },
      { name: "Opened by", value: `<@${input.openerId}>`, inline: true },
      { name: "Actor", value: `<@${input.actorId}>`, inline: true },
    ],
    payload: { ticketNumber: input.ticketNumber, openerId: input.openerId },
  };
}
