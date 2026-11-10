import { AuditLogEvent, Events, type Client } from "discord.js";
import type { Config } from "../../config.js";
import { truncate } from "../../format.js";
import { serializeError, type Logger } from "../../logger.js";
import { AuditLogResolver } from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditActor, AuditEventInput, AuditField } from "../types.js";

interface AutomodRuleLike {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly triggerType?: number | string;
  readonly actions?: readonly { readonly type: number | string }[];
  readonly exemptRoles?: { readonly size: number };
  readonly exemptChannels?: { readonly size: number };
}

export interface AutomodExecutionLike {
  readonly guildId?: string;
  readonly ruleId: string;
  readonly ruleName?: string;
  readonly ruleTriggerType?: number | string;
  readonly action?: { readonly type: number | string; readonly metadata?: unknown } | number | string;
  readonly channelId?: string | null;
  readonly userId?: string | null;
  readonly content?: string | null;
  readonly matchedKeyword?: string | null;
  readonly matchedContent?: string | null;
  readonly messageAuthor?: { readonly id: string; readonly tag?: string; readonly username?: string } | null;
}

function label(value: number | string | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

function actionLabel(action: AutomodExecutionLike["action"]): string {
  if (action === undefined) {
    return "unknown";
  }
  return typeof action === "object" ? label(action.type) : label(action);
}

export function automodExecutionEvent(
  execution: AutomodExecutionLike,
  guildId: string,
): AuditEventInput {
  const ruleName = execution.ruleName ?? execution.ruleId;
  const author = execution.messageAuthor ?? null;
  const fields: AuditField[] = [
    { name: "Rule", value: ruleName, inline: true },
    { name: "Trigger", value: label(execution.ruleTriggerType), inline: true },
    { name: "Action", value: actionLabel(execution.action), inline: true },
  ];
  if (execution.channelId) {
    fields.push({ name: "Channel", value: `<#${execution.channelId}>`, inline: true });
  }
  if (author) {
    fields.push({
      name: "Author",
      value: `${author.tag ?? author.username ?? author.id} (${author.id})`,
      inline: true,
    });
  } else if (execution.userId) {
    fields.push({ name: "Author", value: `<@${execution.userId}>`, inline: true });
  }
  if (execution.matchedKeyword) {
    fields.push({ name: "Matched keyword", value: truncate(execution.matchedKeyword, 200) });
  }
  if (execution.matchedContent) {
    fields.push({ name: "Matched content", value: truncate(execution.matchedContent, 500) });
  } else if (execution.content) {
    fields.push({ name: "Content", value: truncate(execution.content, 500) });
  }

  return {
    category: "automod",
    type: "automod.execution",
    summary: `AutoMod fired: ${ruleName}`,
    severity: "warn",
    ...(author ? { actor: { id: author.id, tag: author.tag ?? author.username ?? author.id } } : {}),
    ...(execution.channelId ? { channelId: execution.channelId } : {}),
    fields,
    payload: { guildId, ruleId: execution.ruleId },
  };
}

export type AutomodRuleChange = "create" | "update" | "delete";

export function automodRuleEvent(
  kind: AutomodRuleChange,
  rule: AutomodRuleLike,
  guildId: string,
  actor: AuditActor | null,
): AuditEventInput {
  const actions = (rule.actions ?? []).map((action) => label(action.type));
  return {
    category: "automod",
    type: `automod.rule${kind === "create" ? "Create" : kind === "update" ? "Update" : "Delete"}`,
    summary: `AutoMod rule ${rule.name} ${kind === "create" ? "created" : `${kind}d`}`,
    severity: kind === "delete" ? "warn" : "info",
    ...(actor ? { actor } : {}),
    target: { id: rule.id, name: rule.name },
    fields: [
      { name: "Rule", value: rule.name, inline: true },
      { name: "Trigger", value: label(rule.triggerType), inline: true },
      { name: "Enabled", value: rule.enabled ? "yes" : "no", inline: true },
      { name: "Actions", value: actions.length > 0 ? actions.join(", ") : "none" },
      { name: "Exempt roles", value: String(rule.exemptRoles?.size ?? 0), inline: true },
      { name: "Exempt channels", value: String(rule.exemptChannels?.size ?? 0), inline: true },
    ],
    payload: { guildId },
  };
}

export interface AutomodRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly logger: Logger;
}

export function registerAutomodRecorder(client: Client, deps: AutomodRecorderDeps): void {
  const { config, audit, resolver, logger } = deps;
  const recent = (): Date => new Date(Date.now() - 10_000);

  client.on(Events.AutoModerationActionExecution, (execution) => {
    void (async () => {
      if (execution.guild.id !== config.guildId) {
        return;
      }
      audit.record(
        automodExecutionEvent(execution as unknown as AutomodExecutionLike, config.guildId),
      );
    })().catch((error: unknown) => {
      logger.warn("AutoMod execution recorder failed", serializeError(error));
    });
  });

  client.on(Events.AutoModerationRuleCreate, (value) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || value.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.AutoModerationRuleCreate,
        value.id,
        recent(),
      );
      audit.record(
        automodRuleEvent("create", value as unknown as AutomodRuleLike, config.guildId, actor),
      );
    })().catch((error: unknown) => {
      logger.warn("AutoMod rule create recorder failed", serializeError(error));
    });
  });

  client.on(Events.AutoModerationRuleUpdate, (before, after) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || after.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.AutoModerationRuleUpdate,
        after.id,
        recent(),
      );
      audit.record(
        automodRuleEvent("update", after as unknown as AutomodRuleLike, config.guildId, actor),
      );
      if (before?.enabled !== after.enabled) {
        audit.record({
          category: "automod",
          type: "automod.ruleState",
          summary: `AutoMod rule ${after.name} ${after.enabled ? "enabled" : "disabled"}`,
          severity: "warn",
          ...(actor ? { actor } : {}),
          target: { id: after.id, name: after.name },
          fields: [
            { name: "Rule", value: after.name, inline: true },
            { name: "Enabled", value: after.enabled ? "yes" : "no", inline: true },
          ],
          payload: { guildId: config.guildId },
        });
      }
    })().catch((error: unknown) => {
      logger.warn("AutoMod rule update recorder failed", serializeError(error));
    });
  });

  client.on(Events.AutoModerationRuleDelete, (value) => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild || value.guild.id !== config.guildId) {
        return;
      }
      const actor = await resolver.resolve(
        guild,
        AuditLogEvent.AutoModerationRuleDelete,
        value.id,
        recent(),
      );
      audit.record(
        automodRuleEvent("delete", value as unknown as AutomodRuleLike, config.guildId, actor),
      );
    })().catch((error: unknown) => {
      logger.warn("AutoMod rule delete recorder failed", serializeError(error));
    });
  });
}
