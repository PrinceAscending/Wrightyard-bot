import { join } from "node:path";
import type { Client, GatewayIntentBits, Guild } from "discord.js";
import type { Config } from "./config.js";
import { BotDatabase } from "./db.js";
import { serializeError, type Logger } from "./logger.js";
import { AuditLogResolver } from "./audit/attribution.js";
import type { AuditChannelMap } from "./audit/channels.js";
import { AuditCursorStore } from "./audit/cursors.js";
import { AuditDispatcher } from "./audit/dispatcher.js";
import { ensureAuditChannels } from "./audit/ensure.js";
import { AuditReconciler } from "./audit/reconcile.js";
import { registerAuditRecorder } from "./audit/recorder.js";
import { AuditSeenStore } from "./audit/seen.js";
import { AuditService } from "./audit/service.js";
import { AuditStore } from "./audit/store.js";
import { WebhookTracker } from "./audit/webhooks.js";
import { RestoreService } from "./security/restore.js";
import { RaidGuard } from "./security/raid.js";
import { SecurityService } from "./security/service.js";
import { SnapshotService } from "./security/snapshot-service.js";
import { SnapshotStore } from "./security/snapshot.js";
import { SecurityStateStore } from "./security/state.js";
import { StaffActions } from "./staff/actions.js";
import { CaseStore } from "./staff/cases.js";
import { StaffChannelActions } from "./staff/channels.js";
import { DutyStore } from "./staff/duty.js";
import { MaintenanceService } from "./staff/maintenance.js";
import { runShutdown, type ShutdownStep } from "./runtime/shutdown.js";
import { VERSION } from "./version.js";

/**
 * The process-wide service graph consumed by commands, gateway recorders, and
 * the ready/initialize path.
 */
export interface Runtime {
  readonly audit: AuditService;
  readonly auditStore: AuditStore;
  readonly cases: CaseStore;
  readonly duty: DutyStore;
  readonly staff: StaffActions;
  readonly staffChannels: StaffChannelActions;
  readonly security: SecurityService;
  readonly raid: RaidGuard;
  readonly snapshots: SnapshotService;
  readonly webhooks: WebhookTracker;
  readonly reconciler: AuditReconciler;
  readonly cursors: AuditCursorStore;
  readonly maintenance: MaintenanceService;
  readonly auditChannels: AuditChannelMap;
  initialize(guild: Guild): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CreateRuntimeOptions {
  readonly client: Client;
  readonly config: Config;
  readonly logger: Logger;
  readonly dataDir?: string;
  readonly intents?: readonly GatewayIntentBits[];
}

const FLUSH_TIMEOUT_MS = 5_000;

function storeMode(durable: boolean): string {
  return durable ? "mongodb" : "json";
}

class AssembledRuntime implements Runtime {
  public readonly audit: AuditService;
  public readonly auditStore: AuditStore;
  public readonly cases: CaseStore;
  public readonly duty: DutyStore;
  public readonly staff: StaffActions;
  public readonly staffChannels: StaffChannelActions;
  public readonly security: SecurityService;
  public readonly raid: RaidGuard;
  public readonly snapshots: SnapshotService;
  public readonly webhooks: WebhookTracker;
  public readonly reconciler: AuditReconciler;
  public readonly cursors: AuditCursorStore;
  public readonly maintenance: MaintenanceService;

  private readonly client: Client;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly database: BotDatabase;
  private readonly snapshotStore: SnapshotStore;
  private readonly stateStore: SecurityStateStore;
  private readonly seenStore: AuditSeenStore;
  private channels: AuditChannelMap = new Map();
  private initialized = false;
  private shuttingDown = false;

  public constructor(options: CreateRuntimeOptions) {
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger;
    const dataDir = options.dataDir ?? "data";
    const path = (name: string): string => join(dataDir, name);

    this.database = new BotDatabase({
      uri: options.config.mongoUri,
      dbName: options.config.mongoDb,
      logger: options.logger.child("db"),
    });
    const database = options.config.mongoUri ? this.database : null;

    this.auditStore = new AuditStore({
      database,
      jsonPath: path("audit.ndjson"),
      logger: options.logger.child("audit-store"),
      retentionDays: options.config.auditRetentionDays,
    });
    this.cases = new CaseStore({
      database,
      jsonPath: path("mod-cases.json"),
      logger: options.logger.child("cases"),
    });
    this.duty = new DutyStore({
      database,
      jsonPath: path("staff-duty.json"),
      logger: options.logger.child("duty"),
    });
    this.snapshotStore = new SnapshotStore({
      database,
      jsonPath: path("guild-snapshot.json"),
      logger: options.logger.child("snapshots"),
    });
    this.stateStore = new SecurityStateStore({
      database,
      jsonPath: path("security-state.json"),
      logger: options.logger.child("security-state"),
    });
    this.seenStore = new AuditSeenStore({
      database,
      jsonPath: path("audit-seen.json"),
      logger: options.logger.child("audit-seen"),
    });
    this.cursors = new AuditCursorStore({
      database,
      jsonPath: path("audit-cursors.json"),
      logger: options.logger.child("audit-cursors"),
    });

    const dispatcher = new AuditDispatcher({
      client: options.client,
      config: options.config,
      logger: options.logger.child("audit-dispatcher"),
      resolveChannels: () => this.channels,
    });
    this.audit = new AuditService({
      guildId: options.config.guildId,
      store: this.auditStore,
      sink: dispatcher,
      logger: options.logger.child("audit"),
    });

    const restore = new RestoreService({
      client: options.client,
      config: options.config,
      snapshotStore: this.snapshotStore,
      audit: this.audit,
      logger: options.logger.child("restore"),
    });
    this.security = new SecurityService({
      client: options.client,
      config: options.config,
      cases: this.cases,
      audit: this.audit,
      restore,
      state: this.stateStore,
      logger: options.logger.child("security"),
    });
    this.raid = new RaidGuard({
      config: options.config,
      security: this.security,
      audit: this.audit,
      logger: options.logger.child("raid"),
      state: this.stateStore,
    });
    this.snapshots = new SnapshotService({
      getGuild: () => this.client.guilds.cache.get(options.config.guildId) ?? null,
      store: this.snapshotStore,
      audit: this.audit,
      config: options.config,
      logger: options.logger.child("snapshot-service"),
    });
    this.staff = new StaffActions({
      client: options.client,
      config: options.config,
      cases: this.cases,
      audit: this.audit,
      logger: options.logger.child("staff"),
    });
    this.staffChannels = new StaffChannelActions({
      client: options.client,
      config: options.config,
      cases: this.cases,
      audit: this.audit,
      logger: options.logger.child("staff-channels"),
    });
    this.maintenance = new MaintenanceService({
      guildId: options.config.guildId,
      cases: this.cases,
      duty: this.duty,
      logger: options.logger.child("maintenance"),
    });

    const resolver = new AuditLogResolver({
      client: options.client,
      logger: options.logger.child("audit-resolver"),
      seen: this.seenStore,
    });
    this.webhooks = new WebhookTracker({
      resolver,
      security: this.security,
      logger: options.logger.child("webhooks"),
    });
    this.reconciler = new AuditReconciler({
      client: options.client,
      config: options.config,
      audit: this.audit,
      logger: options.logger.child("reconciler"),
      cursors: this.cursors,
      seen: this.seenStore,
    });

    registerAuditRecorder({
      client: options.client,
      config: options.config,
      audit: this.audit,
      resolver,
      security: this.security,
      webhooks: this.webhooks,
      logger: options.logger.child("recorders"),
    });

    this.audit.record({
      category: "lifecycle",
      type: "bot.startup",
      summary: "Runtime assembled",
      severity: "info",
      feed: false,
      fields: [
        { name: "Version", value: VERSION, inline: true },
        { name: "Intents", value: String(options.intents?.length ?? 0), inline: true },
        { name: "Audit store", value: storeMode(this.auditStore.durable), inline: true },
        { name: "Case store", value: storeMode(this.cases.durable), inline: true },
        { name: "Security mode", value: options.config.antiNukeMode, inline: true },
      ],
      payload: {
        version: VERSION,
        intents: options.intents?.length ?? 0,
        auditStore: storeMode(this.auditStore.durable),
        caseStore: storeMode(this.cases.durable),
        securityMode: options.config.antiNukeMode,
        securityEnabled: options.config.antiNukeEnabled,
      },
    });
  }

  public get auditChannels(): AuditChannelMap {
    return this.channels;
  }

  public async initialize(guild: Guild): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    let created = 0;
    let warnings: readonly string[] = [];
    try {
      const result = await ensureAuditChannels(
        guild,
        this.config,
        this.logger.child("audit-channels"),
      );
      this.channels = result.channels;
      created = result.created.length;
      warnings = result.warnings;
      for (const warning of result.warnings) {
        this.logger.warn(warning);
      }
    } catch (error) {
      this.logger.warn("Audit channel provisioning failed", serializeError(error));
    }

    try {
      await this.webhooks.warm(guild);
    } catch (error) {
      this.logger.warn("Webhook baseline warm-up failed", serializeError(error));
    }

    try {
      await this.raid.restoreState();
    } catch (error) {
      this.logger.warn("Raid state restore failed", serializeError(error));
    }

    try {
      const stale = await this.maintenance.initialize();
      if (stale > 0) {
        this.logger.info("Closed stale duty sessions", { count: stale });
      }
    } catch (error) {
      this.logger.warn("Maintenance initialization failed", serializeError(error));
    }
    this.maintenance.start();
    this.snapshots.start();
    this.reconciler.start();

    this.audit.record({
      category: "lifecycle",
      type: "bot.ready",
      summary: "Runtime ready",
      severity: "info",
      feed: false,
      fields: [
        { name: "Version", value: VERSION, inline: true },
        { name: "Channels", value: String(this.channels.size), inline: true },
        { name: "Created", value: String(created), inline: true },
        {
          name: "Stores",
          value: `audit ${storeMode(this.auditStore.durable)} · cases ${storeMode(this.cases.durable)}`,
        },
        { name: "Warnings", value: String(warnings.length), inline: true },
      ],
      payload: {
        version: VERSION,
        guildId: guild.id,
        channels: [...this.channels.entries()],
        created,
        warnings: [...warnings],
        auditStore: storeMode(this.auditStore.durable),
        caseStore: storeMode(this.cases.durable),
      },
    });
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    this.audit.record({
      category: "lifecycle",
      type: "bot.shutdown",
      summary: "Runtime shutting down",
      severity: "info",
      feed: false,
      fields: [
        { name: "Version", value: VERSION, inline: true },
        {
          name: "Stores",
          value: `audit ${storeMode(this.auditStore.durable)} · cases ${storeMode(this.cases.durable)}`,
        },
      ],
      payload: {
        version: VERSION,
        auditStore: storeMode(this.auditStore.durable),
        caseStore: storeMode(this.cases.durable),
      },
    });

    const steps: readonly ShutdownStep[] = [
      { name: "reconciler", run: () => this.reconciler.stop() },
      { name: "snapshots", run: () => this.snapshots.stop() },
      { name: "maintenance", run: () => this.maintenance.stop() },
      { name: "security", run: () => this.security.flush() },
      { name: "audit-flush", run: () => this.audit.flush() },
      { name: "audit-close", run: () => this.audit.close() },
      { name: "cases", run: () => this.cases.close() },
      { name: "duty", run: () => this.duty.close() },
      { name: "snapshot-store", run: () => this.snapshotStore.close() },
      { name: "state", run: () => this.stateStore.close() },
      { name: "audit-seen", run: () => this.seenStore.close() },
      { name: "audit-cursors", run: () => this.cursors.close() },
      { name: "database", run: () => this.database.close() },
    ];

    await runShutdown(steps, this.logger.child("shutdown"), FLUSH_TIMEOUT_MS);
  }
}

/** Builds every store and service once, before `client.login`. */
export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  return new AssembledRuntime(options);
}
