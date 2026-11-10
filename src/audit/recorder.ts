import { Events, type Client } from "discord.js";
import type { Config } from "../config.js";
import { type Logger } from "../logger.js";
import type { SecurityObserver } from "../security/types.js";
import type { AuditLogResolver } from "./attribution.js";
import type { AuditService } from "./service.js";
import type { AuditEventInput } from "./types.js";
import { WebhookTracker } from "./webhooks.js";
import { registerAutomodRecorder } from "./recorders/automod.js";
import { registerChannelRecorder } from "./recorders/server-channels.js";
import { registerMemberRecorder } from "./recorders/members.js";
import { registerMessageRecorder } from "./recorders/messages.js";
import { registerScheduledEventRecorder } from "./recorders/scheduled-events.js";
import { registerStructureRecorder } from "./recorders/server-structure.js";
import { registerVoiceRecorder } from "./recorders/voice.js";

export interface AuditRecorderOptions {
  readonly client: Client;
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly webhooks?: WebhookTracker;
  readonly logger: Logger;
}

function lifecycle(type: string, summary: string, severity: AuditEventInput["severity"], fields: AuditEventInput["fields"]): AuditEventInput {
  return { category: "lifecycle", type, summary, severity, feed: false, fields };
}

/**
 * Registers every gateway recorder exactly once. Runtime assembly calls this;
 * `bot.startup` and `bot.ready` belong to the runtime so they are not repeated
 * here.
 */
export function registerAuditRecorder(options: AuditRecorderOptions): void {
  const { client, config, audit, resolver, security, logger } = options;
  const webhooks =
    options.webhooks ?? new WebhookTracker({ resolver, security, logger });

  registerMessageRecorder(client, { config, audit, resolver, security, logger });
  registerMemberRecorder(client, { config, audit, resolver, security, logger });
  registerChannelRecorder(client, { config, audit, resolver, security, logger });
  registerStructureRecorder(client, {
    config,
    audit,
    resolver,
    security,
    webhooks,
    logger,
  });
  registerVoiceRecorder(client, { config, audit, logger });
  registerAutomodRecorder(client, { config, audit, resolver, logger });
  registerScheduledEventRecorder(client, { config, audit, resolver, logger });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    audit.record(
      lifecycle(
        "bot.shardDisconnect",
        `Shard ${shardId} disconnected (${event.code})`,
        "warn",
        [
          { name: "Shard", value: String(shardId), inline: true },
          { name: "Code", value: String(event.code), inline: true },
          { name: "Reason", value: event.reason || "none" },
        ],
      ),
    );
  });

  client.on(Events.Error, (error) => {
    audit.record(
      lifecycle("bot.error", "Discord client error", "warn", [
        { name: "Error", value: error.message || error.name },
      ]),
    );
  });
}
