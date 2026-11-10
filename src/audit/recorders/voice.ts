import { Events, type Client } from "discord.js";
import type { Config } from "../../config.js";
import { serializeError, type Logger } from "../../logger.js";
import type { AuditService } from "../service.js";
import type { AuditEventInput, AuditField } from "../types.js";

interface VoiceUserLike {
  readonly id: string;
  readonly tag?: string;
  readonly username?: string;
}

export interface VoiceStateLike {
  readonly guildId?: string;
  readonly channelId: string | null;
  readonly userId?: string;
  readonly member?: { readonly id: string; readonly user: VoiceUserLike } | null;
  readonly selfMute?: boolean;
  readonly selfDeaf?: boolean;
  readonly serverMute?: boolean;
  readonly serverDeaf?: boolean;
  readonly streaming?: boolean;
  readonly selfVideo?: boolean;
  readonly suppress?: boolean;
}

function voiceUser(state: VoiceStateLike): VoiceUserLike | null {
  if (state.member) {
    return state.member.user;
  }
  return state.userId ? { id: state.userId } : null;
}

function tagOf(user: VoiceUserLike): string {
  return user.tag ?? user.username ?? user.id;
}

function muted(state: VoiceStateLike): boolean {
  return Boolean(state.selfMute || state.serverMute);
}

function deafened(state: VoiceStateLike): boolean {
  return Boolean(state.selfDeaf || state.serverDeaf);
}

function changed(before: VoiceStateLike, after: VoiceStateLike): boolean {
  return (
    before.channelId !== after.channelId ||
    muted(before) !== muted(after) ||
    deafened(before) !== deafened(after) ||
    Boolean(before.streaming) !== Boolean(after.streaming) ||
    Boolean(before.selfVideo) !== Boolean(after.selfVideo) ||
    Boolean(before.suppress) !== Boolean(after.suppress)
  );
}

export function voiceStateEvent(
  before: VoiceStateLike,
  after: VoiceStateLike,
  guildId: string,
): AuditEventInput | null {
  if (!changed(before, after)) {
    return null;
  }
  const user = voiceUser(after) ?? voiceUser(before);
  if (!user) {
    return null;
  }

  let type = "voice.state";
  let summary = `Voice state updated for ${tagOf(user)}`;
  if (!before.channelId && after.channelId) {
    type = "voice.join";
    summary = `${tagOf(user)} joined <#${after.channelId}>`;
  } else if (before.channelId && !after.channelId) {
    type = "voice.leave";
    summary = `${tagOf(user)} left <#${before.channelId}>`;
  } else if (before.channelId && after.channelId && before.channelId !== after.channelId) {
    type = "voice.move";
    summary = `${tagOf(user)} moved from <#${before.channelId}> to <#${after.channelId}>`;
  }

  const channelId = after.channelId ?? before.channelId ?? undefined;
  const fields: AuditField[] = [
    { name: "User", value: `${tagOf(user)} (${user.id})`, inline: true },
    { name: "Before", value: before.channelId ? `<#${before.channelId}>` : "none", inline: true },
    { name: "After", value: after.channelId ? `<#${after.channelId}>` : "none", inline: true },
    { name: "Muted", value: muted(after) ? "yes" : "no", inline: true },
    { name: "Deafened", value: deafened(after) ? "yes" : "no", inline: true },
    { name: "Streaming", value: after.streaming ? "yes" : "no", inline: true },
    { name: "Camera", value: after.selfVideo ? "yes" : "no", inline: true },
  ];

  return {
    category: "voice",
    type,
    summary,
    actor: { id: user.id, tag: tagOf(user) },
    ...(channelId ? { channelId } : {}),
    fields,
    payload: { guildId },
  };
}

export interface VoiceRecorderDeps {
  readonly config: Config;
  readonly audit: AuditService;
  readonly logger: Logger;
}

export function registerVoiceRecorder(client: Client, deps: VoiceRecorderDeps): void {
  const { config, audit, logger } = deps;
  client.on(Events.VoiceStateUpdate, (before, after) => {
    void (async () => {
      if (after.guild.id !== config.guildId) {
        return;
      }
      const event = voiceStateEvent(
        before as unknown as VoiceStateLike,
        after as unknown as VoiceStateLike,
        config.guildId,
      );
      if (event) {
        audit.record(event);
      }
    })().catch((error: unknown) => {
      logger.warn("Voice recorder failed", serializeError(error));
    });
  });
}
