import type { Command, CommandRegistry } from "./types.js";
import admin from "./commands/admin.js";
import ask from "./commands/ask.js";
import brief from "./commands/brief.js";
import help from "./commands/help.js";
import leaderboard from "./commands/leaderboard.js";
import rank from "./commands/rank.js";
import site from "./commands/site.js";
import stats from "./commands/stats.js";
import status from "./commands/status.js";
import ticket from "./commands/ticket.js";

// Static imports keep the command registry visible to the bundler. The
// standalone index.js has no command directory to scan at runtime.
const COMMAND_MODULES: readonly Command[] = [
  admin,
  ask,
  brief,
  help,
  leaderboard,
  rank,
  site,
  stats,
  status,
  ticket,
];

function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Command> & { data?: { name?: unknown; toJSON?: unknown } };
  return (
    typeof candidate.data?.name === "string" &&
    typeof candidate.data.toJSON === "function" &&
    typeof candidate.execute === "function"
  );
}

export async function loadCommands(): Promise<CommandRegistry> {
  const commands = new Map<string, Command>();

  for (const command of COMMAND_MODULES) {
    if (!isCommand(command)) {
      throw new Error("A command module does not export a valid command.");
    }

    if (commands.has(command.data.name)) {
      throw new Error(`Duplicate command name: ${command.data.name}`);
    }

    try {
      command.data.toJSON();
    } catch (error) {
      throw new Error(`Command ${command.data.name} is not serializable: ${errorMessage(error)}`);
    }

    commands.set(command.data.name, command);
  }

  if (commands.size === 0) {
    throw new Error("No commands found.");
  }

  return commands;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
