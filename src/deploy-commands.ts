import "./env.js";
import { REST, Routes } from "discord.js";
import { loadDeployConfig } from "./config.js";
import { loadCommands } from "./load-commands.js";
import { Logger, serializeError } from "./logger.js";

async function main(): Promise<void> {
  const logger = new Logger("deploy");
  const config = loadDeployConfig();
  const commands = await loadCommands(new URL("./commands/", import.meta.url));
  const body = [...commands.values()].map((command) => command.data.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);
  const result = (await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body,
  })) as unknown[];

  logger.info("Commands deployed to the guild", {
    count: Array.isArray(result) ? result.length : body.length,
    guildId: config.guildId,
    commands: body.map((command) => command.name),
  });
}

main().catch((error: unknown) => {
  const logger = new Logger("deploy");
  logger.error("Command deployment failed", { error: serializeError(error) });
  process.exitCode = 1;
});
