export type DestructiveKind =
  | "channelDelete" | "roleDelete" | "ban" | "kick" | "webhookCreate"
  | "channelCreate" | "roleCreate" | "memberRoleUpdate" | "emojiDelete"
  | "stickerDelete" | "inviteCreate" | "guildUpdate" | "bulkDelete"
  | "threadDelete";

export interface ObservedAction {
  kind: DestructiveKind;
  guildId: string;
  actorId: string;
  actorTag: string;
  targetId: string | null;
  targetName: string | null;
  at: Date;
  payload?: unknown;
}

export interface SecurityObserver {
  observe(action: ObservedAction): void;
}

export interface IncidentRestorer {
  restoreIncident(actions: readonly ObservedAction[], reason: string): Promise<unknown>;
}

export interface SecurityStatePort {
  get(guildId: string): Promise<{ raidMode: boolean; raidUntil: Date | null }>;
  setRaidMode(guildId: string, until: Date | null): Promise<void>;
  markAction(guildId: string, actorId: string, at: Date): Promise<void>;
  markAlert(guildId: string, at: Date): Promise<void>;
}
