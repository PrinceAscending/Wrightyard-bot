import type { Config } from "../config.js";
import type { Client, Guild, GuildMember } from "discord.js";
import type { Logger } from "../logger.js";
import type { AuditService } from "../audit/service.js";
import type { AuditEventInput } from "../audit/types.js";
import type { CaseFilter, CaseStatus, ModerationCase, NewCase } from "../staff/cases.js";

export const GUILD_ID = "1566778873985892442";
export const BOT_ID = "1566784935342252032";
export const OWNER_ID = "971329961313046578";
export const USER_ID = "1567000000000000001";
export const STAFF_ID = "1567000000000000002";
export const ACTOR_ID = "1567000000000000003";
export const TARGET_ID = "1567000000000000004";
export const CHANNEL_ID = "1567000000000000005";
export const CATEGORY_ID = "1567000000000000006";
export const MESSAGE_LOG_ID = "1567000000000000007";
export const ROLE_ID = "1567000000000000008";
export const STAFF_ROLE_ID = "1567000000000000009";
export const MOD_ID = "1567000000000000010";
export const STEWARD_ID = "1567000000000000011";
export const ADMIN_ID = "1567000000000000012";
export const QUARANTINE_ID = "1567000000000000013";
export const TRUSTED_ID = "1567000000000000014";
export const AUTHOR_ID = "1567000000000000015";
export const OTHER_ID = "1567000000000000016";
export const EVERYONE_ID = GUILD_ID;

export const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "test-token",
    clientId: BOT_ID,
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    siteUrl: null,
    heartbeatSecret: null,
    announcementsChannelId: null,
    ticketPanelChannelId: null,
    ticketLogChannelId: null,
    staffRoleIds: [STAFF_ROLE_ID],
    ticketCategoryId: null,
    autoRoleIds: [],
    botAutoRoleIds: [],
    levelRoles: [],
    welcomeChannelId: null,
    levelUpChannelId: null,
    mongoUri: null,
    mongoDb: "wrightyard",
    groqApiKey: null,
    groqModel: "test",
    port: 8080,
    nodeEnv: "test",
    logCategoryId: CATEGORY_ID,
    logChannelId: null,
    messageLogChannelId: MESSAGE_LOG_ID,
    memberLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    securityLogChannelId: null,
    modLogChannelId: null,
    logMessageContent: true,
    auditRetentionDays: 0,
    staffModeratorRoleIds: [],
    staffStewardRoleIds: [],
    staffAdminRoleIds: [],
    staffFounderRoleIds: [],
    antiNukeEnabled: true,
    antiNukeMode: "quarantine",
    antiNukeTrustedUserIds: [],
    antiNukeQuarantineRoleId: QUARANTINE_ID,
    antiNukeRestore: true,
    raidGuardEnabled: true,
    raidJoinThreshold: 8,
    raidWindowSeconds: 60,
    raidMinAccountAgeDays: 7,
    raidModeMinutes: 10,
    snapshotIntervalMinutes: 360,
    ...overrides,
  };
}

export interface FakeMemberOptions {
  readonly id?: string;
  readonly roles?: readonly string[];
  readonly bot?: boolean;
  readonly joinedTimestamp?: number | null;
  readonly displayName?: string;
  readonly tag?: string;
}

export function makeMember(options: FakeMemberOptions = {}): GuildMember {
  const id = options.id ?? USER_ID;
  const tag = options.tag ?? "user#0001";
  const username = tag.split("#")[0] ?? "user";
  return {
    id,
    user: { id, bot: options.bot ?? false, tag, username },
    displayName: options.displayName ?? username,
    joinedTimestamp: options.joinedTimestamp ?? Date.now(),
    roles: {
      cache: new Map((options.roles ?? []).map((roleId) => [roleId, { id: roleId }])),
    },
  } as unknown as GuildMember;
}

export function fakeClient(guilds: Guild[] = []): Client {
  const stub = {
    user: { id: BOT_ID, tag: "wrightyard#0001", username: "wrightyard", bot: true },
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    channels: { cache: new Map() },
    on: () => stub,
    once: () => stub,
    isReady: () => true,
  };
  return stub as unknown as Client;
}

export class FakeAudit {
  public readonly events: AuditEventInput[] = [];

  public record(event: AuditEventInput): void {
    this.events.push(event);
  }

  public recordNow(event: AuditEventInput): AuditEventInput {
    this.events.push(event);
    return event;
  }

  public async flush(): Promise<void> {
    return undefined;
  }

  public async close(): Promise<void> {
    return undefined;
  }
}

export function asAuditService(fake: FakeAudit): AuditService {
  return fake as unknown as AuditService;
}

type MutableCase = { -readonly [Key in keyof ModerationCase]: ModerationCase[Key] };

const CLOSED_CASE_ACTIONS = new Set<NewCase["action"]>([
  "kick",
  "purge",
  "lock",
  "unlock",
  "slowmode",
  "note",
  "unban",
  "untimeout",
  "warnClear",
  "caseResolve",
]);

/**
 * In-memory CaseStore stand-in. Mirrors the real defaults so task tests can
 * assert status transitions without a filesystem.
 */
export class FakeCaseStore {
  public readonly records: MutableCase[] = [];
  private next = 1;

  public get durable(): boolean {
    return false;
  }

  public async create(input: NewCase): Promise<ModerationCase> {
    const now = new Date();
    const status: CaseStatus =
      input.status ?? (CLOSED_CASE_ACTIONS.has(input.action) ? "closed" : "open");
    const record: MutableCase = {
      caseId: this.next++,
      guildId: input.guildId,
      action: input.action,
      targetId: input.targetId ?? null,
      targetTag: input.targetTag ?? null,
      moderatorId: input.moderatorId,
      moderatorTag: input.moderatorTag ?? input.moderatorId,
      reason: input.reason ?? "",
      durationMs: input.durationMs ?? null,
      expiresAt: input.expiresAt ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      status,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    return record;
  }

  public async get(guildId: string, caseId: number): Promise<ModerationCase | null> {
    return (
      this.records.find(
        (record) => record.guildId === guildId && record.caseId === caseId,
      ) ?? null
    );
  }

  public async list(guildId: string, filter: CaseFilter = {}): Promise<ModerationCase[]> {
    return this.records
      .filter((record) => record.guildId === guildId)
      .filter((record) => !filter.targetId || record.targetId === filter.targetId)
      .filter((record) => !filter.moderatorId || record.moderatorId === filter.moderatorId)
      .filter((record) => !filter.action || record.action === filter.action)
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.since || record.createdAt.getTime() >= filter.since.getTime())
      .sort((a, b) => b.caseId - a.caseId)
      .slice(0, filter.limit ?? 100);
  }

  public async updateStatus(
    guildId: string,
    caseId: number,
    status: CaseStatus,
    actorId: string,
    note?: string,
  ): Promise<void> {
    const record = this.records.find(
      (entry) => entry.guildId === guildId && entry.caseId === caseId,
    );
    if (!record) {
      return;
    }
    record.status = status;
    record.updatedAt = new Date();
    record.metadata = {
      ...record.metadata,
      statusActorId: actorId,
      ...(note ? { statusNote: note } : {}),
    };
  }

  public async countByModerator(
    guildId: string,
    moderatorId: string,
    since: Date,
  ): Promise<number> {
    return this.records.filter(
      (record) =>
        record.guildId === guildId &&
        record.moderatorId === moderatorId &&
        record.createdAt.getTime() >= since.getTime(),
    ).length;
  }

  public async close(): Promise<void> {
    return undefined;
  }
}

export function asCaseStore(fake: FakeCaseStore): import("../staff/cases.js").CaseStore {
  return fake as unknown as import("../staff/cases.js").CaseStore;
}
