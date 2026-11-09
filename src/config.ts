const SNOWFLAKE = /^\d{17,20}$/;

export type AntiNukeMode = "alert" | "quarantine" | "ban";

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
  readonly logCategoryId: string | null;
  readonly logChannelId: string | null;
  readonly messageLogChannelId: string | null;
  readonly memberLogChannelId: string | null;
  readonly serverLogChannelId: string | null;
  readonly voiceLogChannelId: string | null;
  readonly securityLogChannelId: string | null;
  readonly modLogChannelId: string | null;
  readonly logMessageContent: boolean;
  readonly auditRetentionDays: number;
  readonly staffModeratorRoleIds: readonly string[];
  readonly staffStewardRoleIds: readonly string[];
  readonly staffAdminRoleIds: readonly string[];
  readonly staffFounderRoleIds: readonly string[];
  readonly antiNukeEnabled: boolean;
  readonly antiNukeMode: AntiNukeMode;
  readonly antiNukeTrustedUserIds: readonly string[];
  readonly antiNukeQuarantineRoleId: string | null;
  readonly antiNukeRestore: boolean;
  readonly raidGuardEnabled: boolean;
  readonly raidJoinThreshold: number;
  readonly raidWindowSeconds: number;
  readonly raidMinAccountAgeDays: number;
  readonly raidModeMinutes: number;
  readonly snapshotIntervalMinutes: number;
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

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new ConfigError(`${name} must be true or false.`);
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseAntiNukeMode(raw: string | undefined): AntiNukeMode {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return "quarantine";
  }
  if (value === "alert" || value === "quarantine" || value === "ban") {
    return value;
  }
  throw new ConfigError("ANTINUKE_MODE must be alert, quarantine, or ban.");
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

function parseIdListValue(raw: string | undefined, invalidMessage: string): string[] {
  const value = raw?.trim();
  if (!value) {
    return [];
  }

  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) {
      throw new ConfigError(invalidMessage);
    }
  }

  return [...new Set(ids)];
}

function parseStaffRoleIds(raw: string | undefined): string[] {
  return parseIdListValue(raw, "STAFF_ROLE_IDS contains an invalid Discord role ID.");
}

function parseOptionalIdList(env: NodeJS.ProcessEnv, name: string): string[] {
  return parseIdListValue(env[name], `${name} contains an invalid Discord ID.`);
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

  return parseIdListValue(value, `${name} contains an invalid Discord ID.`);
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

  const logCategoryId = snowflake(env, "LOG_CATEGORY_ID", false);
  const logChannelId = snowflake(env, "LOG_CHANNEL_ID", false);
  const messageLogChannelId = snowflake(env, "MESSAGE_LOG_CHANNEL_ID", false);
  const memberLogChannelId = snowflake(env, "MEMBER_LOG_CHANNEL_ID", false);
  const serverLogChannelId = snowflake(env, "SERVER_LOG_CHANNEL_ID", false);
  const voiceLogChannelId = snowflake(env, "VOICE_LOG_CHANNEL_ID", false);
  const securityLogChannelId = snowflake(env, "SECURITY_LOG_CHANNEL_ID", false);
  const modLogChannelId = snowflake(env, "MOD_LOG_CHANNEL_ID", false);
  const logMessageContent = parseBoolean(env, "LOG_MESSAGE_CONTENT", true);
  const auditRetentionDays = parseInteger(env, "AUDIT_RETENTION_DAYS", 0, 0, 3650);

  if (!announcementsChannelId) {
    warnings.push("ANNOUNCEMENTS_CHANNEL_ID is not set; /admin announce needs an explicit channel.");
  }
  if (!ticketPanelChannelId) {
    warnings.push("TICKET_PANEL_CHANNEL_ID is not set; the bot will look for #open-a-ticket by name.");
  }
  if (!ticketLogChannelId) {
    warnings.push("TICKET_LOG_CHANNEL_ID is not set; ticket closures will not be logged to a staff channel.");
  }

  const parsedStaffRoleIds = parseStaffRoleIds(env.STAFF_ROLE_IDS);
  const staffModeratorRoleIds = parseOptionalIdList(env, "STAFF_MODERATOR_ROLE_IDS");
  const staffStewardRoleIds = parseOptionalIdList(env, "STAFF_STEWARD_ROLE_IDS");
  const staffAdminRoleIds = parseOptionalIdList(env, "STAFF_ADMIN_ROLE_IDS");
  const staffFounderRoleIds = parseOptionalIdList(env, "STAFF_FOUNDER_ROLE_IDS");
  const staffTierRoleIds = [
    ...staffModeratorRoleIds,
    ...staffStewardRoleIds,
    ...staffAdminRoleIds,
    ...staffFounderRoleIds,
  ];
  const staffRoleIds = [...new Set([...parsedStaffRoleIds, ...staffTierRoleIds])];
  if (staffRoleIds.length === 0) {
    warnings.push("STAFF_ROLE_IDS and every staff tier are empty; ticket opening will refuse.");
  }

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

  const antiNukeEnabled = parseBoolean(env, "ANTINUKE_ENABLED", true);
  const antiNukeMode = parseAntiNukeMode(env.ANTINUKE_MODE);
  const antiNukeTrustedUserIds = parseIdList(
    env,
    "ANTINUKE_TRUSTED_USER_IDS",
    warnings,
    "ANTINUKE_TRUSTED_USER_IDS is empty; no users are exempt from anti-nuke rules.",
  );
  const antiNukeQuarantineRoleId = snowflake(env, "ANTINUKE_QUARANTINE_ROLE_ID", false);
  const antiNukeRestore = parseBoolean(env, "ANTINUKE_RESTORE", true);
  const raidGuardEnabled = parseBoolean(env, "RAID_GUARD_ENABLED", true);
  const raidJoinThreshold = parseInteger(env, "RAID_JOIN_THRESHOLD", 8, 1, 1000);
  const raidWindowSeconds = parseInteger(env, "RAID_WINDOW_SECONDS", 60, 1, 86_400);
  const raidMinAccountAgeDays = parseInteger(env, "RAID_MIN_ACCOUNT_AGE_DAYS", 7, 0, 3650);
  const raidModeMinutes = parseInteger(env, "RAID_MODE_MINUTES", 10, 1, 10_080);
  const snapshotIntervalMinutes = parseInteger(
    env,
    "SNAPSHOT_INTERVAL_MINUTES",
    360,
    1,
    10_080,
  );

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
      logCategoryId,
      logChannelId,
      messageLogChannelId,
      memberLogChannelId,
      serverLogChannelId,
      voiceLogChannelId,
      securityLogChannelId,
      modLogChannelId,
      logMessageContent,
      auditRetentionDays,
      staffModeratorRoleIds,
      staffStewardRoleIds,
      staffAdminRoleIds,
      staffFounderRoleIds,
      antiNukeEnabled,
      antiNukeMode,
      antiNukeTrustedUserIds,
      antiNukeQuarantineRoleId,
      antiNukeRestore,
      raidGuardEnabled,
      raidJoinThreshold,
      raidWindowSeconds,
      raidMinAccountAgeDays,
      raidModeMinutes,
      snapshotIntervalMinutes,
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
