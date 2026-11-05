const TICKET_TOPIC = /^Wrightyard ticket #(\d{4,}) · opener (\d{17,20}) · (?:claimed by (\d{17,20}) · )?(open|closed)$/;
const MAX_CHANNEL_NAME = 90;

export type TicketStatus = "open" | "closed";

export interface TicketRecord {
  readonly channelId: string;
  readonly number: number;
  readonly openerId: string;
  readonly openedAt: Date;
  openerTag: string | null;
  claimedById: string | null;
  status: TicketStatus;
  introMessageId: string | null;
}

export interface ParsedTicketTopic {
  readonly number: number;
  readonly openerId: string;
  readonly claimedById: string | null;
  readonly status: TicketStatus;
}

export function ticketNumber(number: number): string {
  return String(number).padStart(4, "0");
}

export function ticketTopic(record: Pick<TicketRecord, "number" | "openerId" | "claimedById" | "status">): string {
  const number = ticketNumber(record.number);
  const claim = record.claimedById ? ` · claimed by ${record.claimedById}` : "";
  return `Wrightyard ticket #${number} · opener ${record.openerId}${claim} · ${record.status}`;
}

export function parseTicketTopic(topic: string | null | undefined): ParsedTicketTopic | null {
  if (!topic) {
    return null;
  }
  const match = TICKET_TOPIC.exec(topic.trim());
  if (!match) {
    return null;
  }

  const [, rawNumber, openerId, claimedById, status] = match;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number < 1) {
    return null;
  }

  return {
    number,
    openerId: openerId!,
    claimedById: claimedById ?? null,
    status: status as TicketStatus,
  };
}

function slugifyUsername(username: string, maxLength: number): string {
  const slug = username
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

  return slug || "guest";
}

export function ticketChannelName(number: number, username: string): string {
  const prefix = `ticket-${ticketNumber(number)}-`;
  return `${prefix}${slugifyUsername(username, MAX_CHANNEL_NAME - prefix.length)}`;
}

export function closedChannelName(currentName: string): string {
  if (currentName.startsWith("closed-")) {
    return currentName.slice(0, MAX_CHANNEL_NAME);
  }
  const prefix = "closed-";
  return `${prefix}${currentName.slice(0, MAX_CHANNEL_NAME - prefix.length)}`;
}

/**
 * In-memory ledger of ticket channels. Durable fields live in each channel's
 * topic, so a restart can rehydrate without a database.
 */
export class TicketStore {
  private readonly records = new Map<string, TicketRecord>();
  private nextNumber = 1;

  public get openCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "open") {
        count += 1;
      }
    }
    return count;
  }

  public get count(): number {
    return this.records.size;
  }

  public get(channelId: string): TicketRecord | undefined {
    return this.records.get(channelId);
  }

  public add(record: TicketRecord): void {
    this.records.set(record.channelId, record);
    this.nextNumber = Math.max(this.nextNumber, record.number + 1);
  }

  public remove(channelId: string): void {
    this.records.delete(channelId);
  }

  public markClosed(channelId: string): void {
    const record = this.records.get(channelId);
    if (record) {
      record.status = "closed";
    }
  }

  public allocateNumber(): number {
    const number = this.nextNumber;
    this.nextNumber += 1;
    return number;
  }

  public releaseNumber(number: number): void {
    if (this.nextNumber === number + 1) {
      this.nextNumber = number;
    }
  }

  public observeNumber(number: number): void {
    this.nextNumber = Math.max(this.nextNumber, number + 1);
  }

  public findOpenByOpener(openerId: string): TicketRecord | undefined {
    for (const record of this.records.values()) {
      if (record.status === "open" && record.openerId === openerId) {
        return record;
      }
    }
    return undefined;
  }

  public all(): IterableIterator<TicketRecord> {
    return this.records.values();
  }
}
