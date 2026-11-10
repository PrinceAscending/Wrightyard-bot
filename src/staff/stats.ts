import type { CaseStore, ModerationCase } from "./cases.js";
import type { DutyStore } from "./duty.js";

export interface StaffStatsInput {
  readonly moderatorId: string;
  readonly cases: CaseStore;
  readonly duty: DutyStore;
  readonly days: number;
  readonly guildId?: string;
  readonly now?: Date;
}

export interface StaffStats {
  readonly moderatorId: string;
  readonly days: number;
  readonly actions: Record<string, number>;
  readonly totalActions: number;
  readonly dutyMinutes: number;
  readonly activeDays: number;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function buildStaffStats(input: StaffStatsInput): Promise<StaffStats> {
  const days = Math.max(1, Math.trunc(input.days));
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const guildId = input.guildId ?? "";

  const records = await input.cases.list(guildId, {
    moderatorId: input.moderatorId,
    since,
    limit: 1_000,
  });

  const actions: Record<string, number> = {};
  for (const record of records) {
    actions[record.action] = (actions[record.action] ?? 0) + 1;
  }

  const activeDays = new Set(records.map((record: ModerationCase) => dayKey(record.createdAt))).size;

  return {
    moderatorId: input.moderatorId,
    days,
    actions,
    totalActions: records.length,
    dutyMinutes: await input.duty.minutesSince(guildId, input.moderatorId, since),
    activeDays,
  };
}
