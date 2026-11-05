import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command, CommandRegistry } from "./types.js";

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

export async function loadCommands(directory: URL): Promise<CommandRegistry> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (name.endsWith(".js") || name.endsWith(".ts")) && !name.endsWith(".d.ts"))
    .sort();

  const commands = new Map<string, Command>();
  const basePath = fileURLToPath(directory);

  for (const file of files) {
    const fileUrl = pathToFileURL(join(basePath, file));
    const module = (await import(fileUrl.href)) as { default?: unknown };
    const command = module.default;

    if (!isCommand(command)) {
      throw new Error(`Command module ${file} does not export a valid command.`);
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
    throw new Error(`No commands found in ${basePath}.`);
  }

  return commands;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
