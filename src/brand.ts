export const BRAND = {
  name: "Wrightyard",
  tagline: "Software, built here. Kept running.",
  footer: "Wrightyard · Software, built here. Kept running.",
  colors: {
    ink: 0x17130f,
    paper: 0xf0e7d3,
    red: 0xc33a2c,
    blue: 0x244b70,
    brass: 0xa77d42,
  },
  invite: "https://discord.gg/6m6e5aFkyh",
  paths: {
    dashboard: "/dashboard",
    status: "/status",
  },
} as const;

export function siteUrl(base: string | null, path = "/"): string | null {
  if (!base) {
    return null;
  }

  try {
    const normalized = new URL(base);
    const basePath = normalized.pathname.endsWith("/")
      ? normalized.pathname
      : `${normalized.pathname}/`;
    const relative = path.replace(/^\/+/, "");
    return new URL(relative, `${normalized.origin}${basePath}`).toString();
  } catch {
    return null;
  }
}

export function channelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
