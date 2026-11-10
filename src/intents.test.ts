import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayIntentBits } from "discord.js";
import { GATEWAY_INTENTS } from "./intents.js";

test("enables logging intents but not presence", () => {
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildMembers));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.MessageContent));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildModeration));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildInvites));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildVoiceStates));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildExpressions));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildWebhooks));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildScheduledEvents));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.AutoModerationConfiguration));
  assert.ok(GATEWAY_INTENTS.includes(GatewayIntentBits.AutoModerationExecution));
  assert.equal(GATEWAY_INTENTS.includes(GatewayIntentBits.GuildPresences), false);
});
