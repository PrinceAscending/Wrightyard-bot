import { GatewayIntentBits } from "discord.js";

/**
 * Least-privilege gateway intents for logging, moderation, invites, voice, and
 * auto-moderation. Presence is deliberately excluded; the bot never reads it.
 */
export const GATEWAY_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution,
];
