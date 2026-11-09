const SNOWFLAKE = /^\d{17,20}$/;

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

export interface LevelRole {
  readonly level: number;
  readonly roleId: string;
}

export interface Config {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
  readonly ownerId: string;
  readonly siteUrl: string | null;
  readonly heartbeatSecret: string | null;
  readonly announcementsChannelId: string | null;
  readonly ticketPanelChannelId: string | null;
  readonly ticketLogChannelId: string | null;
  readonly staffRoleIds: readonly string[];
  readonly ticketCategoryId: string | null;
  readonly autoRoleIds: readonly string[];
  readonly botAutoRoleIds: readonly string[];
  readonly levelRoles: readonly LevelRole[];
  readonly welcomeChannelId: string | null;
  readonly levelUpChannelId: string | null;
  readonly mongoUri: string | null;
  readonly mongoDb: string;
  readonly groqApiKey: string | null;
  readonly groqModel: string;
  readonly port: number;
  readonly nodeEnv: string;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly warnings: readonly string[];
}

export interface DeployConfig {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is missing.`);
  }
  return value;
}

function snowflake(env: NodeJS.ProcessEnv, name: string, requiredValue: boolean): string | null {
  const value = env[name]?.trim();
  if (!value) {
    if (requiredValue) {
      throw new ConfigError(`${name} is missing.`);
    }
    return null;
  }
  if (!SNOWFLAKE.test(value)) {
    throw new ConfigError(`${name} is not a valid Discord ID.`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) {
    return 8080;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseSiteUrl(raw: string | undefined, warnings: string[]): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (value.includes("your-site.vercel.app")) {
    warnings.push("SITE_URL is still the example placeholder; website links and heartbeat are disabled.");
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("SITE_URL must be a valid http(s) URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("SITE_URL must use http or https.");
  }

  return url.toString().replace(/\/$/, "");
}

function parseHeartbeatSecret(raw: string | undefined, warnings: string[]): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (value.includes("replace-with")) {
    warnings.push("BOT_HEARTBEAT_SECRET is still the example placeholder; heartbeat is disabled.");
    return null;
  }
  if (value.length < 32) {
    throw new ConfigError("BOT_HEARTBEAT_SECRET must be at least 32 characters.");
  }
  return value;
}

function parseMongoUri(raw: string | undefined, warnings: string[]): string | null {
  const value = raw?.trim();
  if (!value) {
    warnings.push("MONGODB_URI is not set; the ticket ledger will stay in memory.");
    return null;
  }
  if (value.includes("replace-with") || value.includes("<password>")) {
    warnings.push("MONGODB_URI is still a placeholder; the ticket ledger will stay in memory.");
    return null;
  }
  if (!value.startsWith("mongodb://") && !value.startsWith("mongodb+srv://")) {
    throw new ConfigError("MONGODB_URI must start with mongodb:// or mongodb+srv://.");
  }
  return value;
}

function parseGroqApiKey(raw: string | undefined, warnings: string[]): string | null {
  const value = raw?.trim();
  if (!value) {
    warnings.push("GROQ_API_KEY is not set; /ask and /brief are disabled.");
    return null;
  }
  if (value.includes("replace-with")) {
    warnings.push("GROQ_API_KEY is still the example placeholder; AI commands are disabled.");
    return null;
  }
  if (!value.startsWith("gsk_")) {
    warnings.push("GROQ_API_KEY does not look like a Groq key; AI commands may fail.");
  }
  return value;
}

function parseGroqModel(raw: string | undefined): string {
  const value = raw?.trim();
  return value || "openai/gpt-oss-20b";
}

function parseStaffRoleIds(raw: string | undefined, warnings: string[]): string[] {
  const value = raw?.trim();
  if (!value) {
    warnings.push("STAFF_ROLE_IDS is empty; ticket opening will refuse until staff roles are configured.");
    return [];
  }

  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    warnings.push("STAFF_ROLE_IDS is empty; ticket opening will refuse until staff roles are configured.");
    return [];
  }

  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) {
      throw new ConfigError("STAFF_ROLE_IDS contains an invalid Discord role ID.");
    }
  }

  return [...new Set(ids)];
}

function parseIdList(
  env: NodeJS.ProcessEnv,
  name: string,
  warnings: string[],
  warning: string,
): string[] {
  const value = env[name]?.trim();
  if (!value) {
    warnings.push(warning);
    return [];
  }

  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) {
      throw new ConfigError(`${name} contains an invalid Discord ID.`);
    }
  }

  return [...new Set(ids)];
}

function parseLevelRoles(env: NodeJS.ProcessEnv, warnings: string[]): LevelRole[] {
  const value = env.LEVEL_ROLE_IDS?.trim();
  if (!value) {
    warnings.push("LEVEL_ROLE_IDS is empty; level roles will not be assigned.");
    return [];
  }

  const roles: LevelRole[] = [];
  const seenLevels = new Set<number>();

  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [rawLevel, rawRoleId] = entry.split(":");
    const level = Number(rawLevel?.trim());
    const roleId = rawRoleId?.trim();

    if (!Number.isInteger(level) || level < 1 || level > 100) {
      throw new ConfigError("LEVEL_ROLE_IDS must use level:roleId pairs with levels between 1 and 100.");
    }
    if (!roleId || !SNOWFLAKE.test(roleId)) {
      throw new ConfigError("LEVEL_ROLE_IDS contains an invalid Discord role ID.");
    }
    if (seenLevels.has(level)) {
      throw new ConfigError(`LEVEL_ROLE_IDS contains duplicate level ${level}.`);
    }

    seenLevels.add(level);
    roles.push({ level, roleId });
  }

  return roles.sort((a, b) => a.level - b.level);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const warnings: string[] = [];

  const token = required(env, "DISCORD_TOKEN");
  if (token === "replace-with-bot-token") {
    throw new ConfigError("DISCORD_TOKEN is still the example placeholder. Set a real bot token.");
  }
  const clientId = snowflake(env, "DISCORD_CLIENT_ID", true);
  const guildId = snowflake(env, "DISCORD_GUILD_ID", true);
  const ownerId = snowflake(env, "OWNER_ID", true);
  const siteUrl = parseSiteUrl(env.SITE_URL, warnings);
  const heartbeatSecret = parseHeartbeatSecret(env.BOT_HEARTBEAT_SECRET, warnings);

  if (siteUrl && !heartbeatSecret) {
    warnings.push("BOT_HEARTBEAT_SECRET is not configured; website heartbeat is disabled.");
  }
  if (!siteUrl && heartbeatSecret) {
    warnings.push("SITE_URL is not configured; website heartbeat is disabled.");
  }

  const announcementsChannelId = snowflake(env, "ANNOUNCEMENTS_CHANNEL_ID", false);
  const ticketPanelChannelId = snowflake(env, "TICKET_PANEL_CHANNEL_ID", false);
  const ticketLogChannelId = snowflake(env, "TICKET_LOG_CHANNEL_ID", false);
  const ticketCategoryId = snowflake(env, "TICKET_CATEGORY_ID", false);

  if (!announcementsChannelId) {
    warnings.push("ANNOUNCEMENTS_CHANNEL_ID is not set; /admin announce needs an explicit channel.");
  }
  if (!ticketPanelChannelId) {
    warnings.push("TICKET_PANEL_CHANNEL_ID is not set; the bot will look for #open-a-ticket by name.");
  }
  if (!ticketLogChannelId) {
    warnings.push("TICKET_LOG_CHANNEL_ID is not set; ticket closures will not be logged to a staff channel.");
  }

  const staffRoleIds = parseStaffRoleIds(env.STAFF_ROLE_IDS, warnings);
  const autoRoleIds = parseIdList(
    env,
    "AUTO_ROLE_IDS",
    warnings,
    "AUTO_ROLE_IDS is empty; new members will not receive a base role.",
  );
  const botAutoRoleIds = parseIdList(
    env,
    "BOT_AUTO_ROLE_IDS",
    warnings,
    "BOT_AUTO_ROLE_IDS is empty; new bots will not receive a marker role.",
  );
  const levelRoles = parseLevelRoles(env, warnings);
  const welcomeChannelId = snowflake(env, "WELCOME_CHANNEL_ID", false);
  const levelUpChannelId = snowflake(env, "LEVEL_UP_CHANNEL_ID", false);
  const mongoUri = parseMongoUri(env.MONGODB_URI, warnings);
  const mongoDb = env.MONGODB_DB?.trim() || "wrightyard";
  const groqApiKey = parseGroqApiKey(env.GROQ_API_KEY, warnings);
  const groqModel = parseGroqModel(env.GROQ_MODEL);

  return {
    config: {
      token,
      clientId: clientId!,
      guildId: guildId!,
      ownerId: ownerId!,
      siteUrl,
      heartbeatSecret,
      announcementsChannelId,
      ticketPanelChannelId,
      ticketLogChannelId,
      staffRoleIds,
      ticketCategoryId,
      autoRoleIds,
      botAutoRoleIds,
      levelRoles,
      welcomeChannelId,
      levelUpChannelId,
      mongoUri,
      mongoDb,
      groqApiKey,
      groqModel,
      port: parsePort(env.PORT),
      nodeEnv: env.NODE_ENV?.trim() || "development",
    },
    warnings,
  };
}

export function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  return {
    token: required(env, "DISCORD_TOKEN"),
    clientId: snowflake(env, "DISCORD_CLIENT_ID", true)!,
    guildId: snowflake(env, "DISCORD_GUILD_ID", true)!,
  };
}
