import "./env.js";
import { deployCommands } from "./deploy.js";
import { Logger, serializeError } from "./logger.js";

deployCommands().catch((error: unknown) => {
  const logger = new Logger("deploy");
  logger.error("Command deployment failed", { error: serializeError(error) });
  process.exitCode = 1;
});
