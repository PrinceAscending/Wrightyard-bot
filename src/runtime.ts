import type { Guild } from "discord.js";
import type { AuditService } from "./audit/service.js";
import type { AuditStore } from "./audit/store.js";
import type { StaffActions } from "./staff/actions.js";
import type { CaseStore } from "./staff/cases.js";
import type { StaffChannelActions } from "./staff/channels.js";
import type { DutyStore } from "./staff/duty.js";
import type { RaidGuard } from "./security/raid.js";
import type { SecurityService } from "./security/service.js";
import type { SnapshotService } from "./security/snapshot-service.js";

/**
 * The process-wide service graph. Task 32 completes the implementation; later
 * security tasks extend this contract before `createRuntime` exists.
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
  initialize(guild: Guild): Promise<void>;
  shutdown(): Promise<void>;
}
