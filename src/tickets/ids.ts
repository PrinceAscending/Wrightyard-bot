export const TICKET_IDS = {
  open: "ticket:open",
  claim: "ticket:claim",
  close: "ticket:close",
  confirmClose: "ticket:confirm-close",
  cancel: "ticket:cancel",
  delete: "ticket:delete",
  confirmDelete: "ticket:confirm-delete",
} as const;

export type TicketAction = (typeof TICKET_IDS)[keyof typeof TICKET_IDS];
