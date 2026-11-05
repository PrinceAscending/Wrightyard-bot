import { MongoClient, type Collection } from "mongodb";
import type { Logger } from "../logger.js";
import { serializeError } from "../logger.js";
import type { TicketRecord } from "./store.js";

const CONNECT_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_MS = 60_000;

type LedgerStatus = "open" | "closed" | "deleted";

type TicketDoc = {
  _id: string;
  guildId: string;
  number: number;
  openerId: string;
  openerTag: string | null;
  claimedById: string | null;
  status: LedgerStatus;
  channelName: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closedById: string | null;
  deletedAt: Date | null;
  deletedById: string | null;
  updatedAt: Date;
};

type TicketLedgerOptions = {
  readonly uri: string | null;
  readonly dbName: string;
  readonly logger: Logger;
};

/**
 * Durable ticket history shared with the website. This is a history ledger, not
 * the source of truth for open ticket state: Discord channel topics remain the
 * recovery mechanism, and a Mongo outage never blocks ticket actions.
 */
export class TicketLedger {
  private readonly uri: string | null;
  private readonly dbName: string;
  private readonly logger: Logger;
  private client: MongoClient | null = null;
  private collectionPromise: Promise<Collection<TicketDoc>> | null = null;
  private indexesPromise: Promise<void> | null = null;
  private unavailableUntil = 0;
  private warnedUnavailable = false;
  private readonly pending = new Set<Promise<void>>();

  public constructor(options: TicketLedgerOptions) {
    this.uri = options.uri;
    this.dbName = options.dbName;
    this.logger = options.logger;
  }

  public get configured(): boolean {
    return Boolean(this.uri);
  }

  public opened(record: TicketRecord, guildId: string, channelName: string): void {
    this.track(
      this.run("open", async (tickets) => {
        const now = new Date();
        await tickets.updateOne(
          { _id: record.channelId },
          {
            $set: {
              guildId,
              number: record.number,
              openerId: record.openerId,
              openerTag: record.openerTag,
              claimedById: record.claimedById,
              status: "open",
              channelName,
              updatedAt: now,
            },
            $setOnInsert: {
              openedAt: record.openedAt,
              closedAt: null,
              closedById: null,
              deletedAt: null,
              deletedById: null,
            },
          },
          { upsert: true },
        );
      }),
    );
  }

  public claimed(record: TicketRecord, guildId: string, channelName: string): void {
    this.track(
      this.run("claim", async (tickets) => {
        await tickets.updateOne(
          { _id: record.channelId },
          {
            $set: {
              guildId,
              number: record.number,
              openerId: record.openerId,
              openerTag: record.openerTag,
              claimedById: record.claimedById,
              status: "open",
              channelName,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              openedAt: record.openedAt,
              closedAt: null,
              closedById: null,
              deletedAt: null,
              deletedById: null,
            },
          },
          { upsert: true },
        );
      }),
    );
  }

  public closed(
    record: TicketRecord,
    guildId: string,
    closedById: string,
    channelName: string,
  ): void {
    this.track(
      this.run("close", async (tickets) => {
        const now = new Date();
        await tickets.updateOne(
          { _id: record.channelId },
          {
            $set: {
              guildId,
              number: record.number,
              openerId: record.openerId,
              openerTag: record.openerTag,
              claimedById: record.claimedById,
              status: "closed",
              channelName,
              closedAt: now,
              closedById,
              updatedAt: now,
            },
            $setOnInsert: {
              openedAt: record.openedAt,
              deletedAt: null,
              deletedById: null,
            },
          },
          { upsert: true },
        );
      }),
    );
  }

  public deleted(record: TicketRecord, deletedById: string | null): void {
    this.track(
      this.run("delete", async (tickets) => {
        const now = new Date();
        await tickets.updateOne(
          { _id: record.channelId },
          {
            $set: {
              number: record.number,
              openerId: record.openerId,
              openerTag: record.openerTag,
              claimedById: record.claimedById,
              status: "deleted",
              deletedAt: now,
              updatedAt: now,
              ...(deletedById ? { deletedById } : {}),
            },
            $setOnInsert: {
              openedAt: record.openedAt,
              closedAt: null,
              closedById: null,
            },
          },
          { upsert: true },
        );
      }),
    );
  }

  public snapshot(
    records: readonly TicketRecord[],
    guildId: string,
    channelNames?: ReadonlyMap<string, string>,
  ): void {
    if (records.length === 0) return;

    this.track(
      this.run("snapshot", async (tickets) => {
        const now = new Date();
        await tickets.bulkWrite(
          records.map((record) => ({
            updateOne: {
              filter: { _id: record.channelId },
              update: {
                $set: {
                  guildId,
                  number: record.number,
                  openerId: record.openerId,
                  openerTag: record.openerTag,
                  claimedById: record.claimedById,
                  status: record.status,
                  channelName: channelNames?.get(record.channelId) ?? null,
                  updatedAt: now,
                },
                $setOnInsert: {
                  openedAt: record.openedAt,
                  closedAt: null,
                  closedById: null,
                  deletedAt: null,
                  deletedById: null,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }),
    );
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    const client = this.client;
    this.client = null;
    this.collectionPromise = null;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => {
      this.pending.delete(work);
    });
  }

  private async run(
    operation: string,
    action: (tickets: Collection<TicketDoc>) => Promise<void>,
  ): Promise<void> {
    if (!this.uri) return;
    if (Date.now() < this.unavailableUntil) return;

    try {
      const tickets = await this.collection();
      await action(tickets);
      this.warnedUnavailable = false;
    } catch (error) {
      this.unavailableUntil = Date.now() + FAILURE_BACKOFF_MS;
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn("Ticket ledger write failed; history will catch up later", {
          operation,
          error: serializeError(error),
        });
      }
    }
  }

  private collection(): Promise<Collection<TicketDoc>> {
    if (!this.collectionPromise) {
      const client = new MongoClient(this.uri!, {
        appName: "WrightyardBot",
        maxPoolSize: 5,
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        connectTimeoutMS: CONNECT_TIMEOUT_MS,
        retryWrites: true,
      });
      this.client = client;
      this.collectionPromise = client
        .connect()
        .then(() => client.db(this.dbName).collection<TicketDoc>("tickets"))
        .then(async (tickets) => {
          this.indexesPromise ??= Promise.all([
            tickets.createIndex({ openedAt: -1 }, { name: "tickets_recent" }),
            tickets.createIndex(
              { openerId: 1, openedAt: -1 },
              { name: "tickets_opener_recent" },
            ),
          ]).then(() => undefined);
          await this.indexesPromise;
          return tickets;
        })
        .catch((error: unknown) => {
          this.collectionPromise = null;
          this.indexesPromise = null;
          throw error;
        });
    }
    return this.collectionPromise;
  }
}
