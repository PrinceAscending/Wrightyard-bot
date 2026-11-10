import { AuditLogEvent, Events, type Client } from "discord.js";
import type { Config } from "../../config.js";
import { serializeError, type Logger } from "../../logger.js";
import type { SecurityObserver } from "../../security/types.js";
import {
  AuditLogResolver,
  attributionFailureEvent,
} from "../attribution.js";
import type { AuditService } from "../service.js";
import type { AuditField, AuditEventInput } from "../types.js";

interface AttachmentLike {
  readonly name: string;
  readonly size: number;
  readonly url: string;
}

export interface MessageLike {
  readonly id: string;
  readonly content: string;
  readonly author: {
    readonly id: string;
    readonly tag?: string;
    readonly username?: string;
    readonly bot?: boolean;
  };
  readonly channelId: string;
  readonly guildId?: string | null;
  readonly attachments: { values(): IterableIterator<AttachmentLike>; readonly size: number };
  readonly embeds: readonly { readonly title?: string | null }[];
}

const MAX_CONTENT = 1_000;
const MAX_ATTACHMENTS = 10;

function authorTag(author: MessageLike["author"]): string {
  return author.tag ?? author.username ?? author.id;
}

function codeBlock(text: string): string {
  const safe = text.replace(/```/g, "``\u200b`");
  return `\`\`\`\n${safe.slice(0, MAX_CONTENT)}\n\`\`\``;
}

function attachmentList(message: MessageLike): string | null {
  const attachments = [...message.attachments.values()].slice(0, MAX_ATTACHMENTS);
  if (attachments.length === 0) {
    return null;
  }
  return attachments
    .map((attachment) => `${attachment.name} (${attachment.size} B) ${attachment.url}`)
    .join("\n");
}

function embedList(message: MessageLike): string | null {
  if (message.embeds.length === 0) {
    return null;
  }
  const titles = message.embeds
    .map((embed) => embed.title)
    .filter((title): title is string => Boolean(title));
  return `${message.embeds.length} embed${message.embeds.length === 1 ? "" : "s"}${
    titles.length > 0 ? `: ${titles.join(", ")}` : ""
  }`;
}

function baseFields(message: MessageLike, includeContent: boolean): AuditField[] {
  const fields: AuditField[] = [
    {
      name: "Author",
      value: `${authorTag(message.author)} (${message.author.id})`,
      inline: true,
    },
    { name: "Channel", value: `<#${message.channelId}>`, inline: true },
  ];

  fields.push({
    name: "Content",
    value: includeContent ? codeBlock(message.content) : "Content unavailable (logging disabled).",
  });

  const attachments = attachmentList(message);
  if (attachments) {
    fields.push({ name: "Attachments", value: attachments });
  }
  const embeds = embedList(message);
  if (embeds) {
    fields.push({ name: "Embeds", value: embeds });
  }
  return fields;
}

export function messageCreateEvent(
  message: MessageLike,
  guildId: string,
  includeContent: boolean,
  feed = false,
): AuditEventInput {
  return {
    category: "message",
    type: "message.create",
    summary: `Message from ${authorTag(message.author)} in <#${message.channelId}>`,
    feed,
    actor: { id: message.author.id, tag: authorTag(message.author) },
    target: { id: message.channelId },
    channelId: message.channelId,
    fields: baseFields(message, includeContent),
    payload: { messageId: message.id },
  };
}

function attachmentSignature(message: MessageLike): string {
  return [...message.attachments.values()]
    .map((attachment) => `${attachment.name}:${attachment.size}:${attachment.url}`)
    .join("|");
}

function embedSignature(message: MessageLike): string {
  return message.embeds.map((embed) => embed.title ?? "").join("|");
}

export function messageUpdateEvents(
  before: MessageLike,
  after: MessageLike,
  guildId: string,
  includeContent: boolean,
): AuditEventInput[] {
  const contentChanged = before.content !== after.content;
  const attachmentsChanged = attachmentSignature(before) !== attachmentSignature(after);
  const embedsChanged = embedSignature(before) !== embedSignature(after);
  if (!contentChanged && !attachmentsChanged && !embedsChanged) {
    return [];
  }

  const render = (message: MessageLike): string =>
    includeContent
      ? codeBlock(message.content)
      : "Content unavailable (logging disabled).";

  const fields: AuditField[] = [
    {
      name: "Author",
      value: `${authorTag(after.author)} (${after.author.id})`,
      inline: true,
    },
    { name: "Channel", value: `<#${after.channelId}>`, inline: true },
    { name: "Before", value: render(before) },
    { name: "After", value: render(after) },
  ];
  const attachments = attachmentList(after);
  if (attachments) {
    fields.push({ name: "Attachments", value: attachments });
  }

  return [
    {
      category: "message",
      type: "message.update",
      summary: `Message edited in <#${after.channelId}>`,
      feed: true,
      actor: { id: after.author.id, tag: authorTag(after.author) },
      target: { id: after.channelId },
      channelId: after.channelId,
      fields,
      payload: { messageId: after.id },
    },
  ];
}

export function messageDeleteEvent(
  message: MessageLike,
  guildId: string,
  includeContent: boolean,
): AuditEventInput {
  return {
    category: "message",
    type: "message.delete",
    summary: `Message deleted in <#${message.channelId}>`,
    feed: true,
    actor: { id: message.author.id, tag: authorTag(message.author) },
    target: { id: message.channelId },
    channelId: message.channelId,
    fields: baseFields(message, includeContent),
    payload: { messageId: message.id },
  };
}

export function messageBulkDeleteEvent(
  messages: { readonly size: number; values(): IterableIterator<MessageLike> },
  channelId: string,
  guildId: string,
): AuditEventInput {
  const ids = [...messages.values()].slice(0, 20).map((message) => message.id);
  return {
    category: "message",
    type: "message.bulkDelete",
    summary: `${messages.size} messages bulk deleted in <#${channelId}>`,
    severity: "warn",
    feed: true,
    target: { id: channelId },
    channelId,
    fields: [
      { name: "Channel", value: `<#${channelId}>`, inline: true },
      { name: "Messages", value: String(messages.size), inline: true },
      { name: "Message IDs", value: ids.join(", ") || "none" },
    ],
    payload: { count: messages.size, ids, guildId },
  };
}

export interface MessageRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly resolver?: AuditLogResolver;
  readonly security?: SecurityObserver;
  readonly logger: Logger;
}

export function registerMessageRecorder(client: Client, deps: MessageRecorderDeps): void {
  const { config, audit, resolver, security, logger } = deps;

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (message.guildId !== config.guildId || message.author.bot) {
        return;
      }
      audit.record(messageCreateEvent(message, config.guildId, config.logMessageContent));
    })().catch((error: unknown) => {
      logger.warn("Message create recorder failed", serializeError(error));
    });
  });

  client.on(Events.MessageUpdate, (before, after) => {
    void (async () => {
      if (after.guildId !== config.guildId || after.author?.bot) {
        return;
      }
      const events = messageUpdateEvents(
        before as unknown as MessageLike,
        after as unknown as MessageLike,
        config.guildId,
        config.logMessageContent,
      );
      for (const event of events) {
        audit.record(event);
      }
    })().catch((error: unknown) => {
      logger.warn("Message update recorder failed", serializeError(error));
    });
  });

  client.on(Events.MessageDelete, (message) => {
    void (async () => {
      if (message.guildId !== config.guildId) {
        return;
      }
      audit.record(
        messageDeleteEvent(
          message as unknown as MessageLike,
          config.guildId,
          config.logMessageContent,
        ),
      );
    })().catch((error: unknown) => {
      logger.warn("Message delete recorder failed", serializeError(error));
    });
  });

  client.on(Events.MessageBulkDelete, (messages, channel) => {
    void (async () => {
      if (channel.guildId !== config.guildId) {
        return;
      }
      const first = messages.first();
      audit.record(
        messageBulkDeleteEvent(
          messages as unknown as Parameters<typeof messageBulkDeleteEvent>[0],
          channel.id,
          config.guildId,
        ),
      );

      const guild = client.guilds.cache.get(config.guildId);
      const actor =
        resolver && guild
          ? await resolver.resolve(
              guild,
              AuditLogEvent.MessageBulkDelete,
              null,
              new Date(Date.now() - 10_000),
            )
          : null;

      if (!actor) {
        audit.record(
          attributionFailureEvent({
            guildId: config.guildId,
            type: "bulkDelete",
            targetId: channel.id,
            targetName: "name" in channel ? channel.name : null,
          }),
        );
        return;
      }

      security?.observe({
        kind: "bulkDelete",
        guildId: config.guildId,
        actorId: actor.id,
        actorTag: actor.tag,
        targetId: channel.id,
        targetName: "name" in channel ? channel.name : null,
        at: new Date(),
        payload: { count: messages.size, sampleId: first?.id ?? null },
      });
    })().catch((error: unknown) => {
      logger.warn("Bulk message delete recorder failed", serializeError(error));
    });
  });
}
