import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { BRAND } from "../brand.js";
import { formatTimestamp } from "../format.js";
import { TICKET_IDS } from "../tickets/ids.js";

export const TICKET_PANEL_FOOTER = "Wrightyard · The gate";
export const TICKET_INTRO_FOOTER_PREFIX = "Wrightyard · Ticket";

export function ticketIntroFooter(ticketNumber: number): string {
  return `${TICKET_INTRO_FOOTER_PREFIX} #${String(ticketNumber).padStart(4, "0")}`;
}

export function buildTicketPanel(): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / THE GATE" })
    .setTitle("Open a ticket.")
    .setDescription(
      [
        "A private room, a real person, and a written record.",
        "Tell us what you are building, what is in the way, and what a good outcome looks like. We will take it from there.",
      ].join("\n"),
    )
    .setColor(BRAND.colors.brass)
    .addFields(
      {
        name: "Before you knock",
        value: [
          "One ticket at a time, please.",
          "Bring the shape of the job: scope, deadline, budget, and any links worth reading.",
          "Do not paste passwords, tokens, or private keys. Staff will ask for access through a safer channel if it is needed.",
        ].join("\n"),
      },
      {
        name: "What happens next",
        value: [
          "A private channel opens under the ticket desk.",
          "A studio member claims it and answers there.",
          "When the work is settled, the ticket closes. The record stays.",
        ].join("\n"),
      },
      {
        name: "The fine print",
        value: "Opening a ticket does not start a job or reserve a slot. Scope and terms are agreed in writing first.",
      },
    )
    .setFooter({ text: TICKET_PANEL_FOOTER });
}

export function ticketPanelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.open)
      .setLabel("Open a ticket")
      .setStyle(ButtonStyle.Secondary),
  );
}

export interface TicketIntroView {
  readonly number: number;
  readonly openerId: string;
  readonly claimedById: string | null;
  readonly openedAt: Date;
  readonly closed: boolean;
}

export function buildTicketIntro(view: TicketIntroView): EmbedBuilder {
  const status = view.closed ? "Closed" : view.claimedById ? "Claimed" : "Open";
  const claimed = view.claimedById ? `<@${view.claimedById}>` : "Not yet";

  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / THE GATE" })
    .setTitle(`Ticket #${String(view.number).padStart(4, "0")}`)
    .setDescription(
      view.closed
        ? "This room is closed. The ledger entry remains for reference."
        : "A private room for the job. A studio member will claim it when they pick up the work.",
    )
    .setColor(view.closed ? BRAND.colors.ink : BRAND.colors.brass)
    .addFields(
      { name: "Opened by", value: `<@${view.openerId}>`, inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Claimed by", value: claimed, inline: true },
      { name: "Opened", value: formatTimestamp(view.openedAt, "f"), inline: false },
    )
    .setFooter({ text: ticketIntroFooter(view.number) })
    .setTimestamp(view.openedAt);
}

export function ticketIntroRow(view: Pick<TicketIntroView, "claimedById" | "closed">): ActionRowBuilder<ButtonBuilder>[] {
  if (view.closed) {
    return [];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TICKET_IDS.claim)
        .setLabel(view.claimedById ? "Claimed" : "Claim ticket")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(view.claimedById)),
      new ButtonBuilder()
        .setCustomId(TICKET_IDS.close)
        .setLabel("Close ticket")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function closeConfirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.confirmClose)
      .setLabel("Close ticket")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.cancel)
      .setLabel("Keep it open")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function deleteConfirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.confirmDelete)
      .setLabel("Delete channel")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.cancel)
      .setLabel("Keep the record")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function closedNoteRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.delete)
      .setLabel("Delete channel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildTicketClosedNote(number: number, closedById: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / THE LEDGER" })
    .setTitle("Ticket closed.")
    .setDescription(
      "The ledger entry is closed. The room stays until a studio member removes it; the record is kept for reference.",
    )
    .setColor(BRAND.colors.ink)
    .addFields(
      { name: "Ticket", value: `#${String(number).padStart(4, "0")}`, inline: true },
      { name: "Closed by", value: `<@${closedById}>`, inline: true },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}

export interface TicketLogView {
  readonly channelId: string;
  readonly number: number;
  readonly openerId: string;
  readonly claimedById: string | null;
  readonly closedById: string;
  readonly openedAt: Date;
  readonly closedAt: Date;
}

export function buildTicketLog(view: TicketLogView): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: "WRIGHTYARD / TICKET DESK" })
    .setTitle(`Ticket #${String(view.number).padStart(4, "0")} closed`)
    .setColor(BRAND.colors.brass)
    .addFields(
      { name: "Channel", value: `<#${view.channelId}>`, inline: true },
      { name: "Opened by", value: `<@${view.openerId}>`, inline: true },
      { name: "Claimed by", value: view.claimedById ? `<@${view.claimedById}>` : "Not claimed", inline: true },
      { name: "Closed by", value: `<@${view.closedById}>`, inline: true },
      { name: "Opened", value: formatTimestamp(view.openedAt, "f"), inline: true },
      { name: "Closed", value: formatTimestamp(view.closedAt, "f"), inline: true },
    )
    .setFooter({ text: BRAND.footer })
    .setTimestamp(view.closedAt);
}
