import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { Config } from "../config.js";
import type { CooldownStore } from "../cooldowns.js";
import { UserFacingError } from "../errors.js";
import { BRAND } from "../brand.js";
import { formatCount, formatTimestamp } from "../format.js";
import type { Logger } from "../logger.js";
import { hasStaffRole } from "../permissions.js";
import type { BotState } from "../state.js";
import {
  buildTicketClosedNote,
  buildTicketIntro,
  buildTicketLog,
  buildTicketPanel,
  closedNoteRow,
  closeConfirmRow,
  deleteConfirmRow,
  TICKET_PANEL_FOOTER,
  ticketIntroFooter,
  ticketIntroRow,
  ticketPanelRow,
} from "../views/tickets.js";
import { TICKET_IDS } from "./ids.js";
import type { TicketLedger } from "./ledger.js";
import {
  closedChannelName,
  parseTicketTopic,
  ticketChannelName,
  ticketNumber,
  ticketTopic,
  type TicketRecord,
  TicketStore,
} from "./store.js";

const TICKET_OPEN_COOLDOWN_SECONDS = 30;

type PanelChannel = TextChannel | NewsChannel;

interface TicketServiceOptions {
  readonly client: Client;
  readonly config: Config;
  readonly logger: Logger;
  readonly state: BotState;
  readonly cooldowns: CooldownStore;
  readonly store?: TicketStore;
  readonly ledger?: TicketLedger;
}

export class TicketService {
  private readonly client: Client;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly state: BotState;
  private readonly cooldowns: CooldownStore;
  private readonly store: TicketStore;
  private readonly ledger: TicketLedger | null;
  private categoryId: string | null;
  private queueTail: Promise<void> = Promise.resolve();
  private warnedMissingStaff = false;
  private warnedMissingCategory = false;

  public constructor(options: TicketServiceOptions) {
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger;
    this.state = options.state;
    this.cooldowns = options.cooldowns;
    this.store = options.store ?? new TicketStore();
    this.ledger = options.ledger ?? null;
    this.categoryId = options.config.ticketCategoryId;
  }

  public get openCount(): number {
    return this.store.openCount;
  }

  public async initialize(): Promise<void> {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) {
      this.logger.warn("Ticket rehydration skipped: configured guild is not cached.");
      return;
    }

    const category = await this.resolveCategory(guild, false);
    if (!category) {
      this.logger.info("No ticket category yet; it will be created when the first ticket opens.");
      return;
    }

    let open = 0;
    let closed = 0;
    const channelNames = new Map<string, string>();

    for (const channel of guild.channels.cache.values()) {
      if (channel.parentId !== category.id || channel.type !== ChannelType.GuildText) {
        continue;
      }

      const parsed = parseTicketTopic(channel.topic);
      if (!parsed) {
        continue;
      }

      const status = channel.name.startsWith("closed-") ? "closed" : parsed.status;
      this.store.add({
        channelId: channel.id,
        number: parsed.number,
        openerId: parsed.openerId,
        openedAt: channel.createdAt ?? new Date(),
        openerTag: null,
        claimedById: parsed.claimedById,
        status,
        introMessageId: null,
      });
      channelNames.set(channel.id, channel.name);

      if (status === "open") {
        open += 1;
      } else {
        closed += 1;
      }
    }

    this.ledger?.snapshot([...this.store.all()], guild.id, channelNames);
    this.logger.info("Ticket ledger rehydrated", { open, closed, categoryId: category.id });
  }

  public async handleChannelDelete(channelId: string): Promise<void> {
    const record = this.store.get(channelId);
    if (record) {
      this.store.remove(channelId);
      this.ledger?.deleted(record, null);
      this.logger.info("Ticket channel removed", { ticketNumber: record.number, channelId });
    }
  }

  public async open(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    if (this.state.maintenance) {
      await interaction.reply({
        content: "The yard is closed for maintenance. The gate reopens when the work is done.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (this.config.staffRoleIds.length === 0) {
      await interaction.reply({
        content: "Ticket intake is not configured on this deployment. A studio member can open the gate.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const cooldownKey = `ticket:open:${interaction.user.id}`;
    const remaining = this.cooldowns.remainingMs(cooldownKey);
    if (remaining > 0) {
      await interaction.reply({
        content: `Give the gate a moment. Try again in ${Math.ceil(remaining / 1000)}s.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const category = await this.resolveCategory(guild, true);
      if (!category) {
        throw new UserFacingError("I couldn't find or create the ticket category.");
      }

      const existing = this.findOpenForUser(guild, category, interaction.user.id);
      if (existing) {
        await interaction.editReply(`You already have a ticket open: <#${existing.channelId}>.`);
        return;
      }

      const record = await this.enqueue(() => this.createTicket(guild, category, interaction.user));
      this.cooldowns.start(cooldownKey, TICKET_OPEN_COOLDOWN_SECONDS);
      await interaction.editReply(`The gate is open. Your room: <#${record.channelId}>`);

      this.logger.info("Ticket opened", {
        ticketNumber: record.number,
        channelId: record.channelId,
        openerId: record.openerId,
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        await interaction.editReply(error.message);
        return;
      }

      this.logger.error("Ticket creation failed", {
        openerId: interaction.user.id,
        channelId: interaction.channelId,
        error: errorDetails(error),
      });
      await interaction.editReply(
        "I couldn't open a private room just now. The error is logged; please try again or ping a studio member.",
      );
      await this.notifyStaffOfFailure(guild, interaction.user.id);
    }
  }

  public async claim(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    if (!this.isStaff(interaction)) {
      await interaction.reply({
        content: "Only studio staff can claim a ticket.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const channel = this.ticketChannel(interaction.channel);
    const record = channel ? this.resolveTicket(channel) : null;
    if (!channel || !record) {
      await interaction.reply({
        content: "That button belongs to a ticket channel that is no longer on the ledger.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.status === "closed") {
      await interaction.reply({
        content: "This ticket is already closed.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.claimedById) {
      await interaction.reply({
        content: `This ticket is already claimed by <@${record.claimedById}>.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const missing = this.missingChannelPermissions(channel, [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.SendMessages,
    ]);
    if (missing.length > 0) {
      await interaction.reply({
        content: `I need ${formatPermissionList(missing)} in this ticket channel to claim it.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      record.claimedById = interaction.user.id;
      await channel.setTopic(ticketTopic(record), `Ticket #${ticketNumber(record.number)} claimed`);
      await channel.send({
        content: `Claimed by <@${interaction.user.id}>. They will take it from here.`,
        allowedMentions: { parse: [] },
      });
      await this.updateIntro(channel, record);
      this.ledger?.claimed(record, guild.id, channel.name);

      await interaction.editReply(`Ticket #${ticketNumber(record.number)} claimed.`);
      this.logger.info("Ticket claimed", {
        ticketNumber: record.number,
        channelId: record.channelId,
        staffId: interaction.user.id,
      });
    } catch (error) {
      this.logger.error("Ticket claim failed", {
        ticketNumber: record.number,
        channelId: record.channelId,
        staffId: interaction.user.id,
        error: errorDetails(error),
      });
      await interaction.editReply("I couldn't claim that ticket cleanly. The error is logged.");
    }
  }

  public async requestClose(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    const channel = this.ticketChannel(interaction.channel);
    const record = channel ? this.resolveTicket(channel) : null;
    if (!channel || !record) {
      await interaction.reply({
        content: "That button belongs to a ticket channel that is no longer on the ledger.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (!this.canClose(interaction, record)) {
      await interaction.reply({
        content: "Only the person who opened this ticket or a studio member can close it.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.status === "closed") {
      await interaction.reply({
        content: "This ticket is already closed.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({
      content: `Close ticket #${ticketNumber(record.number)}? The room stays on the ledger; staff can remove it later.`,
      components: [closeConfirmRow()],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  public async confirmClose(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    const channel = this.ticketChannel(interaction.channel);
    const record = channel ? this.resolveTicket(channel) : null;
    if (!channel || !record) {
      await interaction.reply({
        content: "That button belongs to a ticket channel that is no longer on the ledger.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (!this.canClose(interaction, record)) {
      await interaction.reply({
        content: "Only the person who opened this ticket or a studio member can close it.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.status === "closed" || channel.name.startsWith("closed-")) {
      await interaction.reply({
        content: "This ticket is already closed.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const missing = this.missingChannelPermissions(channel, [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.SendMessages,
    ]);
    if (missing.length > 0) {
      await interaction.reply({
        content: `I need ${formatPermissionList(missing)} in this ticket channel to close it.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferUpdate();

    try {
      record.status = "closed";
      this.store.markClosed(channel.id);

      await channel.permissionOverwrites.edit(
        record.openerId,
        { SendMessages: false },
        { reason: `Ticket #${ticketNumber(record.number)} closed` },
      );
      const closeReason = `Ticket #${ticketNumber(record.number)} closed`;
      await channel.edit({
        name: closedChannelName(channel.name),
        topic: ticketTopic(record),
        reason: closeReason,
      });
      await this.updateIntro(channel, record);

      await channel.send({
        embeds: [buildTicketClosedNote(record.number, interaction.user.id)],
        components: [closedNoteRow()],
        allowedMentions: { parse: [] },
      });

      await this.logClosure(guild, record, interaction.user.id);
      this.ledger?.closed(record, guild.id, interaction.user.id, channel.name);

      await interaction.editReply({
        content: `Ticket #${ticketNumber(record.number)} is closed. The room stays on the ledger.`,
        components: [],
        embeds: [],
      });

      this.logger.info("Ticket closed", {
        ticketNumber: record.number,
        channelId: record.channelId,
        closedById: interaction.user.id,
      });
    } catch (error) {
      this.logger.error("Ticket close failed", {
        ticketNumber: record.number,
        channelId: record.channelId,
        closedById: interaction.user.id,
        error: errorDetails(error),
      });
      await interaction.editReply({
        content: "I couldn't close the ticket cleanly. The error is logged; a studio member may need to finish it by hand.",
        components: [],
        embeds: [],
      });
    }
  }

  public async requestDelete(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    if (!this.isStaff(interaction)) {
      await interaction.reply({
        content: "Only studio staff can remove a ticket channel.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const channel = this.ticketChannel(interaction.channel);
    const record = channel ? this.resolveTicket(channel) : null;
    if (!channel || !record) {
      await interaction.reply({
        content: "That button belongs to a ticket channel that is no longer on the ledger.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.status !== "closed" && !channel.name.startsWith("closed-")) {
      await interaction.reply({
        content: "Close the ticket before removing the room.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({
      content: `Delete <#${channel.id}>? This removes the channel and its history. This cannot be undone.`,
      components: [deleteConfirmRow()],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  public async confirmDelete(interaction: ButtonInteraction): Promise<void> {
    const guild = this.interactionGuild(interaction);
    if (!guild) {
      return;
    }

    if (!this.isStaff(interaction)) {
      await interaction.reply({
        content: "Only studio staff can remove a ticket channel.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const channel = this.ticketChannel(interaction.channel);
    const record = channel ? this.resolveTicket(channel) : null;
    if (!channel || !record) {
      await interaction.reply({
        content: "That button belongs to a ticket channel that is no longer on the ledger.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (record.status !== "closed" && !channel.name.startsWith("closed-")) {
      await interaction.reply({
        content: "Close the ticket before removing the room.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const missing = this.missingChannelPermissions(channel, [PermissionFlagsBits.ManageChannels]);
    if (missing.length > 0) {
      await interaction.reply({
        content: `I need ${formatPermissionList(missing)} in this ticket channel to remove it.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferUpdate();

    const ticketLabel = `#${ticketNumber(record.number)}`;
    try {
      await this.logDeletion(guild, record, interaction.user.id);
      this.store.remove(channel.id);
      await channel.delete(`Ticket ${ticketLabel} deleted by ${interaction.user.id} after confirmation`);
      this.ledger?.deleted(record, interaction.user.id);
      this.logger.info("Ticket channel deleted", {
        ticketNumber: record.number,
        channelId: record.channelId,
        deletedById: interaction.user.id,
      });
    } catch (error) {
      this.logger.error("Ticket channel delete failed", {
        ticketNumber: record.number,
        channelId: record.channelId,
        deletedById: interaction.user.id,
        error: errorDetails(error),
      });
      await interaction
        .editReply({
          content: "I couldn't delete the channel. The error is logged; a studio member can remove it in Discord.",
          components: [],
          embeds: [],
        })
        .catch(() => undefined);
    }
  }

  public async cancel(interaction: ButtonInteraction): Promise<void> {
    try {
      await interaction.update({ content: "Kept as it is.", components: [], embeds: [] });
    } catch {
      // The ephemeral message may have expired.
    }
  }

  public async postPanel(guild: Guild): Promise<{ message: Message; created: boolean }> {
    const channel = await this.panelChannel(guild);
    const me = guild.members.me;
    if (!me) {
      throw new UserFacingError("I couldn't resolve my own guild member record.");
    }

    const permissions = channel.permissionsFor(me);
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      throw new UserFacingError("I need View Channel, Send Messages, and Embed Links in the ticket panel channel.");
    }

    const embed = buildTicketPanel();
    const row = ticketPanelRow();
    let existing: Message | null = null;

    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      existing =
        recent.find(
          (message) =>
            message.author.id === this.client.user?.id &&
            message.embeds.some((candidate) => candidate.footer?.text === TICKET_PANEL_FOOTER),
        ) ?? null;
    } catch (error) {
      this.logger.warn("Could not inspect the panel channel history", { error: errorDetails(error) });
    }

    if (existing) {
      const message = await existing.edit({ embeds: [embed], components: [row] });
      return { message, created: false };
    }

    const message = await channel.send({
      embeds: [embed],
      components: [row],
      allowedMentions: { parse: [] },
    });
    return { message, created: true };
  }

  private interactionGuild(interaction: ButtonInteraction): Guild | null {
    if (!interaction.inCachedGuild()) {
      void interaction.reply({
        content: "The yard lives in a server. Run this there.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
      return null;
    }

    if (interaction.guildId !== this.config.guildId) {
      void interaction.reply({
        content: "This bot serves a different yard.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
      return null;
    }

    return interaction.guild;
  }

  private isStaff(interaction: ButtonInteraction): boolean {
    return hasStaffRole(interaction.member, this.config.staffRoleIds);
  }

  private canClose(interaction: ButtonInteraction, record: TicketRecord): boolean {
    return this.isStaff(interaction) || interaction.user.id === record.openerId;
  }

  private ticketChannel(channel: ButtonInteraction["channel"]): TextChannel | null {
    if (!channel || channel.type !== ChannelType.GuildText) {
      return null;
    }
    return channel;
  }

  private resolveTicket(channel: TextChannel): TicketRecord | null {
    const existing = this.store.get(channel.id);
    if (existing) {
      return existing;
    }

    const parsed = parseTicketTopic(channel.topic);
    if (!parsed) {
      return null;
    }

    const record: TicketRecord = {
      channelId: channel.id,
      number: parsed.number,
      openerId: parsed.openerId,
      openedAt: channel.createdAt ?? new Date(),
      openerTag: null,
      claimedById: parsed.claimedById,
      status: channel.name.startsWith("closed-") ? "closed" : parsed.status,
      introMessageId: null,
    };
    this.store.add(record);
    return record;
  }

  private findOpenForUser(guild: Guild, category: CategoryChannel, userId: string): TicketRecord | undefined {
    const stored = this.store.findOpenByOpener(userId);
    if (stored) {
      return stored;
    }

    for (const channel of guild.channels.cache.values()) {
      if (channel.parentId !== category.id || channel.type !== ChannelType.GuildText) {
        continue;
      }
      const parsed = parseTicketTopic(channel.topic);
      if (parsed?.status === "open" && parsed.openerId === userId && !channel.name.startsWith("closed-")) {
        const record: TicketRecord = {
          channelId: channel.id,
          number: parsed.number,
          openerId: parsed.openerId,
          openedAt: channel.createdAt ?? new Date(),
          openerTag: null,
          claimedById: parsed.claimedById,
          status: "open",
          introMessageId: null,
        };
        this.store.add(record);
        return record;
      }
    }

    return undefined;
  }

  private async resolveCategory(guild: Guild, create: boolean): Promise<CategoryChannel | null> {
    if (this.categoryId) {
      const current = await this.fetchCategory(guild, this.categoryId);
      if (current) {
        return current;
      }
      if (!this.warnedMissingCategory) {
        this.warnedMissingCategory = true;
        this.logger.warn("Configured ticket category is unavailable; checking by name.", {
          categoryId: this.categoryId,
        });
      }
      this.categoryId = null;
    }

    const byName = guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === "tickets",
    );
    if (byName) {
      this.categoryId = byName.id;
      return byName;
    }

    if (!create) {
      return null;
    }

    return this.createCategory(guild);
  }

  private async fetchCategory(guild: Guild, id: string): Promise<CategoryChannel | null> {
    const cached = guild.channels.cache.get(id);
    if (cached?.type === ChannelType.GuildCategory) {
      return cached;
    }

    try {
      const fetched = await guild.channels.fetch(id);
      return fetched?.type === ChannelType.GuildCategory ? fetched : null;
    } catch {
      return null;
    }
  }

  private async createCategory(guild: Guild): Promise<CategoryChannel> {
    const me = guild.members.me;
    if (
      !me?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      throw new UserFacingError(
        "I need Manage Channels and Manage Roles to create the private ticket desk. A studio member can fix the permissions.",
      );
    }

    const staffRoleIds = this.validStaffRoleIds(guild);
    if (staffRoleIds.length === 0) {
      throw new UserFacingError("Ticket intake is not configured: none of the staff roles exist in this guild.");
    }

    const category = await guild.channels.create({
      name: "Tickets",
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        ...staffRoleIds.map((roleId) => ({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        })),
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ],
      reason: "Wrightyard ticket desk",
    });

    this.categoryId = category.id;
    this.logger.info("Ticket category created", { categoryId: category.id });
    return category;
  }

  private async createTicket(
    guild: Guild,
    category: CategoryChannel,
    user: ButtonInteraction["user"],
  ): Promise<TicketRecord> {
    const me = guild.members.me;
    if (
      !me?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      throw new UserFacingError(
        "I need Manage Channels and Manage Roles to open a private room. A studio member can fix the permissions.",
      );
    }

    const staffRoleIds = this.validStaffRoleIds(guild);
    if (staffRoleIds.length === 0) {
      throw new UserFacingError("Ticket intake is not configured: none of the staff roles exist in this guild.");
    }

    const number = this.store.allocateNumber();
    let channel: TextChannel | null = null;

    try {
      channel = await guild.channels.create({
        name: ticketChannelName(number, user.username),
        type: ChannelType.GuildText,
        parent: category.id,
        topic: ticketTopic({ number, openerId: user.id, claimedById: null, status: "open" }),
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
            ],
          },
          ...staffRoleIds.map((roleId) => ({
            id: roleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
            ],
          })),
          {
            id: me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ManageMessages,
            ],
          },
        ],
        reason: `Ticket #${ticketNumber(number)} opened by ${user.tag}`,
      });

      const record: TicketRecord = {
        channelId: channel.id,
        number,
        openerId: user.id,
        openedAt: new Date(),
        openerTag: user.tag,
        claimedById: null,
        status: "open",
        introMessageId: null,
      };

      const intro = await channel.send({
        embeds: [
          buildTicketIntro({
            number: record.number,
            openerId: record.openerId,
            claimedById: null,
            openedAt: record.openedAt,
            closed: false,
          }),
        ],
        components: ticketIntroRow({ claimedById: null, closed: false }),
        allowedMentions: { parse: [] },
      });

      record.introMessageId = intro.id;
      this.store.add(record);
      this.ledger?.opened(record, guild.id, channel.name);
      return record;
    } catch (error) {
      if (!channel) {
        this.store.releaseNumber(number);
        throw error;
      }

      const partialChannel = channel;
      const cleaned = await partialChannel
        .delete(`Ticket #${ticketNumber(number)} setup failed`)
        .then(() => true)
        .catch((cleanupError: unknown) => {
          this.logger.error("Could not clean up a partial ticket channel", {
            channelId: partialChannel.id,
            error: errorDetails(cleanupError),
          });
          return false;
        });

      if (cleaned) {
        this.store.releaseNumber(number);
      } else {
        this.store.add({
          channelId: partialChannel.id,
          number,
          openerId: user.id,
          openedAt: new Date(),
          openerTag: user.tag,
          claimedById: null,
          status: "open",
          introMessageId: null,
        });
      }

      throw error;
    }
  }

  private async updateIntro(channel: TextChannel, record: TicketRecord): Promise<void> {
    try {
      const intro = await this.findIntro(channel, record);
      if (!intro) {
        this.logger.warn("Ticket intro message not found while updating", {
          ticketNumber: record.number,
          channelId: channel.id,
        });
        return;
      }

      await intro.edit({
        embeds: [
          buildTicketIntro({
            number: record.number,
            openerId: record.openerId,
            claimedById: record.claimedById,
            openedAt: record.openedAt,
            closed: record.status === "closed",
          }),
        ],
        components: ticketIntroRow({ claimedById: record.claimedById, closed: record.status === "closed" }),
      });
    } catch (error) {
      this.logger.warn("Ticket intro update failed", {
        ticketNumber: record.number,
        channelId: channel.id,
        error: errorDetails(error),
      });
    }
  }

  private async findIntro(channel: TextChannel, record: TicketRecord): Promise<Message | null> {
    if (record.introMessageId) {
      const direct = await channel.messages.fetch(record.introMessageId).catch(() => null);
      if (direct) {
        return direct;
      }
    }

    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) {
      return null;
    }

    const footer = ticketIntroFooter(record.number);
    const found =
      recent.find(
        (message) =>
          message.author.id === this.client.user?.id &&
          message.embeds.some((candidate) => candidate.footer?.text === footer),
      ) ?? null;

    if (found) {
      record.introMessageId = found.id;
    }
    return found;
  }

  private async logClosure(guild: Guild, record: TicketRecord, closedById: string): Promise<void> {
    if (!this.config.ticketLogChannelId) {
      return;
    }

    const channel = await this.logChannel(guild);
    if (!channel) {
      return;
    }

    await channel
      .send({
        embeds: [
          buildTicketLog({
            channelId: record.channelId,
            number: record.number,
            openerId: record.openerId,
            claimedById: record.claimedById,
            closedById,
            openedAt: record.openedAt,
            closedAt: new Date(),
          }),
        ],
        allowedMentions: { parse: [] },
      })
      .catch((error: unknown) => {
        this.logger.warn("Ticket closure log failed", {
          ticketNumber: record.number,
          error: errorDetails(error),
        });
      });
  }

  private async logDeletion(guild: Guild, record: TicketRecord, deletedById: string): Promise<void> {
    if (!this.config.ticketLogChannelId) {
      return;
    }

    const channel = await this.logChannel(guild);
    if (!channel) {
      return;
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: "WRIGHTYARD / TICKET DESK" })
      .setTitle(`Ticket #${ticketNumber(record.number)} channel removed`)
      .setColor(BRAND.colors.ink)
      .addFields(
        { name: "Opened by", value: `<@${record.openerId}>`, inline: true },
        { name: "Removed by", value: `<@${deletedById}>`, inline: true },
        { name: "Opened", value: formatTimestamp(record.openedAt, "f"), inline: true },
        { name: "Ledger", value: `${formatCount(this.store.openCount)} open ticket(s) remain.`, inline: false },
      )
      .setFooter({ text: BRAND.footer })
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error: unknown) => {
      this.logger.warn("Ticket deletion log failed", {
        ticketNumber: record.number,
        error: errorDetails(error),
      });
    });
  }

  private async logChannel(guild: Guild): Promise<TextChannel | null> {
    const id = this.config.ticketLogChannelId;
    if (!id) {
      return null;
    }

    const cached = guild.channels.cache.get(id);
    if (cached?.type === ChannelType.GuildText) {
      return cached;
    }

    const fetched = await guild.channels.fetch(id).catch(() => null);
    if (fetched?.type !== ChannelType.GuildText) {
      this.logger.warn("Ticket log channel is missing or not a text channel", { channelId: id });
      return null;
    }
    return fetched;
  }

  private async panelChannel(guild: Guild): Promise<PanelChannel> {
    const configured = this.config.ticketPanelChannelId;
    let channel: GuildBasedChannel | null = null;

    if (configured) {
      channel = guild.channels.cache.get(configured) ?? (await guild.channels.fetch(configured).catch(() => null));
    }

    if (!channel) {
      channel =
        guild.channels.cache.find(
          (candidate): candidate is PanelChannel =>
            (candidate.type === ChannelType.GuildText || candidate.type === ChannelType.GuildAnnouncement) &&
            candidate.name.toLowerCase() === "open-a-ticket",
        ) ?? null;
    }

    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new UserFacingError("I couldn't find the ticket panel channel. Set TICKET_PANEL_CHANNEL_ID or create #open-a-ticket.");
    }

    return channel;
  }

  private validStaffRoleIds(guild: Guild): string[] {
    const valid = this.config.staffRoleIds.filter((roleId) => guild.roles.cache.has(roleId));
    if (valid.length !== this.config.staffRoleIds.length && !this.warnedMissingStaff) {
      this.warnedMissingStaff = true;
      this.logger.warn("Some configured staff roles are missing from the guild.", {
        configured: this.config.staffRoleIds.length,
        present: valid.length,
      });
    }
    return valid;
  }

  private async notifyStaffOfFailure(guild: Guild, openerId: string): Promise<void> {
    if (!this.config.ticketLogChannelId) {
      return;
    }

    const channel = await this.logChannel(guild);
    if (!channel) {
      return;
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: "WRIGHTYARD / TICKET DESK" })
      .setTitle("Ticket intake failed")
      .setColor(BRAND.colors.red)
      .setDescription(
        "A private room could not be created. The user received a safe error and the real error is in the bot logs.",
      )
      .addFields({ name: "Opened by", value: `<@${openerId}>`, inline: true })
      .setFooter({ text: BRAND.footer })
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error: unknown) => {
      this.logger.warn("Ticket failure notice could not be sent", { error: errorDetails(error) });
    });
  }

  private missingChannelPermissions(channel: TextChannel, required: readonly bigint[]): string[] {
    const me = channel.guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    return required
      .filter((permission) => !permissions?.has(permission))
      .map((permission) => permissionName(permission));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function permissionName(permission: bigint): string {
  const names: ReadonlyArray<readonly [bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
    [PermissionFlagsBits.ManageChannels, "Manage Channels"],
    [PermissionFlagsBits.ManageRoles, "Manage Roles"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
  ];
  return names.find(([flag]) => flag === permission)?.[1] ?? "the required permission";
}

function formatPermissionList(permissions: readonly string[]): string {
  if (permissions.length === 1) {
    return permissions[0] ?? "the required permission";
  }
  return `${permissions.slice(0, -1).join(", ")} and ${permissions.at(-1)}`;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; status?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof candidate.code === "string" || typeof candidate.code === "number" ? { code: candidate.code } : {}),
      ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
    };
  }
  return { message: String(error) };
}
