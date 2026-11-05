import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type Role,
} from "discord.js";
import { BRAND, channelUrl } from "../brand.js";
import type { Config } from "../config.js";
import { serializeError, type Logger } from "../logger.js";
import type { LevelStore, XpGrant } from "./levels.js";

/**
 * Community systems: auto-role on entry, a welcome notice, message XP, and
 * level-role promotion. Failures are logged and never block chat.
 */
export class CommunityService {
  public constructor(
    private readonly config: Config,
    private readonly levels: LevelStore,
    private readonly logger: Logger,
  ) {}

  public async onMemberJoin(member: GuildMember): Promise<void> {
    if (member.guild.id !== this.config.guildId || member.user.bot) {
      return;
    }

    if (this.config.autoRoleIds.length > 0) {
      const roles = this.config.autoRoleIds.filter((id) => member.guild.roles.cache.has(id));
      if (roles.length > 0) {
        try {
          await member.roles.add(roles, "Wrightyard auto-role");
        } catch (error) {
          this.logger.warn("Auto-role failed", {
            userId: member.id,
            roles,
            error: serializeError(error),
          });
        }
      }
    }

    const channel = await this.findChannel(member.guild, this.config.welcomeChannelId, "welcome");
    if (!channel) {
      return;
    }

    const rules = this.channelMention(member.guild, "rules");
    const roles = this.channelMention(member.guild, "roles");
    const introductions = this.channelMention(member.guild, "introductions");
    const rulesChannel = this.findNamedChannel(member.guild, "rules");
    const rolesChannel = this.findNamedChannel(member.guild, "roles");
    const ticketChannel = this.findNamedChannel(member.guild, "open-a-ticket");

    const embed = new EmbedBuilder()
      .setAuthor({ name: "WRIGHTYARD / THE GATE" })
      .setTitle("A new name in the ledger.")
      .setDescription(
        `Welcome in, ${member}. The yard is a software studio on one side and an after-hours crew on the other.`,
      )
      .setColor(BRAND.colors.brass)
      .addFields(
        {
          name: "First move",
          value: [
            `Read the rules in ${rules}.`,
            `Pick a crew role in ${roles}.`,
            `Sign the ledger in ${introductions}.`,
          ].join("\n"),
        },
        {
          name: "The bench",
          value: "Weekly challenges, bounties, the lab, design desk, reading room, and ship log.",
        },
      )
      .setThumbnail(member.displayAvatarURL({ size: 128 }))
      .setFooter({ text: BRAND.footer })
      .setTimestamp();

    const buttons: ButtonBuilder[] = [];
    if (rulesChannel) {
      buttons.push(
        new ButtonBuilder()
          .setLabel("Rules")
          .setStyle(ButtonStyle.Link)
          .setURL(channelUrl(member.guild.id, rulesChannel.id)),
      );
    }
    if (rolesChannel) {
      buttons.push(
        new ButtonBuilder()
          .setLabel("Pick roles")
          .setStyle(ButtonStyle.Link)
          .setURL(channelUrl(member.guild.id, rolesChannel.id)),
      );
    }
    if (ticketChannel) {
      buttons.push(
        new ButtonBuilder()
          .setLabel("Open a ticket")
          .setStyle(ButtonStyle.Link)
          .setURL(channelUrl(member.guild.id, ticketChannel.id)),
      );
    }

    try {
      await channel.send({
        content: `<@${member.id}>`,
        embeds: [embed],
        components:
          buttons.length > 0
            ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
            : [],
        allowedMentions: { users: [member.id] },
      });
    } catch (error) {
      this.logger.warn("Welcome notice failed", {
        userId: member.id,
        channelId: channel.id,
        error: serializeError(error),
      });
    }
  }

  public async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || message.system) {
      return;
    }
    if (message.guildId !== this.config.guildId || !this.isXpChannel(message.channel)) {
      return;
    }

    const grant = await this.levels.grantMessageXp(message.author.id);
    if (!grant?.leveledUp) {
      return;
    }

    const member =
      message.member ??
      (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) {
      return;
    }

    const role = await this.applyLevelRole(member, grant.record.level);
    await this.announceLevelUp(member, grant, role?.name ?? null);
  }

  private isXpChannel(channel: Message["channel"]): boolean {
    if (!channel.isTextBased() || channel.isDMBased()) {
      return false;
    }
    const name = channel.name.toLowerCase();
    if (
      name.includes("commands") ||
      name.includes("ticket") ||
      name.includes("staff") ||
      name.includes("client") ||
      name.includes("mod-log")
    ) {
      return false;
    }
    return true;
  }

  private async applyLevelRole(member: GuildMember, level: number): Promise<Role | null> {
    const eligible = this.config.levelRoles
      .filter((entry) => level >= entry.level)
      .sort((a, b) => a.level - b.level);
    const target = eligible.at(-1);
    if (!target) {
      return null;
    }

    const role =
      member.guild.roles.cache.get(target.roleId) ??
      (await member.guild.roles.fetch(target.roleId).catch(() => null));
    if (!role) {
      this.logger.warn("Configured level role is missing", { level: target.level, roleId: target.roleId });
      return null;
    }

    const me = member.guild.members.me;
    if (me && role.position >= me.roles.highest.position) {
      this.logger.warn("Level role sits above the bot and cannot be assigned", {
        role: role.name,
        rolePosition: role.position,
        botPosition: me.roles.highest.position,
      });
      return role;
    }

    try {
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, `Reached level ${level}`);
      }

      const lower = this.config.levelRoles
        .filter((entry) => entry.level < target.level)
        .map((entry) => entry.roleId)
        .filter((id) => member.roles.cache.has(id));

      if (lower.length > 0) {
        await member.roles.remove(lower, "Level role replaced");
      }
    } catch (error) {
      this.logger.warn("Level role update failed", {
        userId: member.id,
        role: role.name,
        error: serializeError(error),
      });
    }

    return role;
  }

  private async announceLevelUp(
    member: GuildMember,
    grant: XpGrant,
    roleName: string | null,
  ): Promise<void> {
    const channel = await this.findChannel(
      member.guild,
      this.config.levelUpChannelId,
      "ship-log",
    );
    if (!channel) {
      return;
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: member.displayName,
        iconURL: member.displayAvatarURL({ size: 128 }),
      })
      .setTitle(`Level ${grant.record.level}`)
      .setDescription(
        roleName
          ? `Another rung on the bench. ${member} reached **level ${grant.record.level}** and picked up **${roleName}**.`
          : `Another rung on the bench. ${member} reached **level ${grant.record.level}**.`,
      )
      .setColor(BRAND.colors.brass)
      .addFields(
        { name: "XP", value: `${grant.record.xp.toLocaleString("en-US")} total`, inline: true },
        { name: "Messages", value: grant.record.messages.toLocaleString("en-US"), inline: true },
      )
      .setFooter({ text: BRAND.footer })
      .setTimestamp();

    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.warn("Level-up notice failed", {
        userId: member.id,
        channelId: channel.id,
        error: serializeError(error),
      });
    }
  }

  private findNamedChannel(
    guild: GuildMember["guild"],
    fragment: string,
  ): GuildTextBasedChannel | null {
    const channel = guild.channels.cache.find(
      (candidate) =>
        candidate.isTextBased() &&
        !candidate.isDMBased() &&
        candidate.name.toLowerCase().includes(fragment),
    );
    return channel?.isTextBased() && !channel.isDMBased() ? channel : null;
  }

  private channelMention(guild: GuildMember["guild"], fragment: string): string {
    const channel = this.findNamedChannel(guild, fragment);
    return channel ? `<#${channel.id}>` : `#${fragment}`;
  }

  private async findChannel(
    guild: GuildMember["guild"],
    configuredId: string | null,
    nameFragment: string,
  ): Promise<GuildTextBasedChannel | null> {
    if (configuredId) {
      const channel =
        guild.channels.cache.get(configuredId) ??
        (await guild.channels.fetch(configuredId).catch(() => null));
      if (channel?.isTextBased() && !channel.isDMBased()) {
        return channel;
      }
    }

    const found = guild.channels.cache.find(
      (channel) =>
        channel.isTextBased() &&
        !channel.isDMBased() &&
        channel.name.toLowerCase().includes(nameFragment),
    );
    return found?.isTextBased() && !found.isDMBased() ? found : null;
  }
}
