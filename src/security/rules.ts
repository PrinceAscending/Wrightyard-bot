import type { AntiNukeMode } from "../config.js";
import type { DestructiveKind, ObservedAction } from "./types.js";

export interface SecurityRule {
  readonly kind: DestructiveKind;
  readonly windowSeconds: number;
  readonly alertAt: number;
  readonly quarantineAt: number;
  readonly banAt: number;
}

/**
 * Order matters: when two rules reach the same severity, the earlier rule wins.
 */
export const SECURITY_RULES: readonly SecurityRule[] = [
  { kind: "channelDelete", windowSeconds: 60, alertAt: 2, quarantineAt: 3, banAt: 6 },
  { kind: "roleDelete", windowSeconds: 60, alertAt: 2, quarantineAt: 3, banAt: 6 },
  { kind: "ban", windowSeconds: 60, alertAt: 3, quarantineAt: 5, banAt: 10 },
  { kind: "kick", windowSeconds: 60, alertAt: 3, quarantineAt: 5, banAt: 10 },
  { kind: "webhookCreate", windowSeconds: 60, alertAt: 2, quarantineAt: 3, banAt: 6 },
  { kind: "channelCreate", windowSeconds: 60, alertAt: 3, quarantineAt: 5, banAt: 10 },
  { kind: "roleCreate", windowSeconds: 60, alertAt: 3, quarantineAt: 5, banAt: 10 },
  { kind: "memberRoleUpdate", windowSeconds: 60, alertAt: 5, quarantineAt: 10, banAt: 20 },
  { kind: "emojiDelete", windowSeconds: 60, alertAt: 5, quarantineAt: 10, banAt: 20 },
  { kind: "stickerDelete", windowSeconds: 60, alertAt: 5, quarantineAt: 10, banAt: 20 },
  { kind: "inviteCreate", windowSeconds: 60, alertAt: 5, quarantineAt: 10, banAt: 20 },
  { kind: "guildUpdate", windowSeconds: 300, alertAt: 1, quarantineAt: 2, banAt: 3 },
  { kind: "bulkDelete", windowSeconds: 60, alertAt: 2, quarantineAt: 3, banAt: 6 },
  { kind: "threadDelete", windowSeconds: 60, alertAt: 3, quarantineAt: 5, banAt: 10 },
];

export type SecurityAction = "none" | "alert" | "quarantine" | "ban";

export interface SecurityDecision {
  readonly action: SecurityAction;
  readonly kind: DestructiveKind | null;
  readonly rule: SecurityRule | null;
  readonly count: number;
}

const NONE: SecurityDecision = { action: "none", kind: null, rule: null, count: 0 };

const SEVERITY: Record<SecurityAction, number> = {
  none: 0,
  alert: 1,
  quarantine: 2,
  ban: 3,
};

function actionFor(rule: SecurityRule, count: number): SecurityAction {
  if (count >= rule.banAt) {
    return "ban";
  }
  if (count >= rule.quarantineAt) {
    return "quarantine";
  }
  if (count >= rule.alertAt) {
    return "alert";
  }
  return "none";
}

function applyMode(action: SecurityAction, mode: AntiNukeMode): SecurityAction {
  if (action === "none") {
    return "none";
  }
  if (mode === "alert") {
    return "alert";
  }
  if (mode === "quarantine" && action === "ban") {
    return "quarantine";
  }
  return action;
}

/**
 * Counts one actor's actions per rule over each rolling window and returns the
 * highest-severity hit the configured mode allows.
 */
export function evaluateSecurity(
  actions: readonly ObservedAction[],
  now: Date,
  mode: AntiNukeMode,
): SecurityDecision {
  let best: SecurityDecision = NONE;
  const nowMs = now.getTime();

  for (const rule of SECURITY_RULES) {
    const windowStart = nowMs - rule.windowSeconds * 1_000;
    let count = 0;
    for (const action of actions) {
      if (action.kind !== rule.kind) {
        continue;
      }
      const at = action.at.getTime();
      if (at >= windowStart && at <= nowMs) {
        count += 1;
      }
    }

    const action = applyMode(actionFor(rule, count), mode);
    if (action === "none" || SEVERITY[action] <= SEVERITY[best.action]) {
      continue;
    }
    best = { action, kind: rule.kind, rule, count };
  }

  return best;
}
