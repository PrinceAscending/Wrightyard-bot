import type {
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { Config } from "./config.js";
import type { CooldownStore } from "./cooldowns.js";
import type { Logger } from "./logger.js";
import type { BotState } from "./state.js";
import type { CommandSyncer } from "./services/command-sync.js";
import type { AIService } from "./services/ai.js";
import type { HeartbeatService } from "./services/heartbeat.js";
import type { LevelStore } from "./services/levels.js";
import type { PresenceService } from "./services/presence.js";
import type { TicketService } from "./tickets/service.js";

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface Command {
  readonly data: SlashCommandData;
  readonly cooldownSeconds?: number;
  readonly ownerOnly?: boolean;
  execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void>;
}

export type CommandRegistry = ReadonlyMap<string, Command>;

export interface BotContext {
  readonly client: Client;
  readonly config: Config;
  readonly logger: Logger;
  readonly state: BotState;
  readonly cooldowns: CooldownStore;
  readonly presence: PresenceService;
  readonly heartbeat: HeartbeatService;
  readonly tickets: TicketService;
  readonly levels: LevelStore;
  readonly ai: AIService;
  readonly syncer: CommandSyncer;
  readonly commands: CommandRegistry;
  readonly version: string;
  readonly startedAt: Date;
}
