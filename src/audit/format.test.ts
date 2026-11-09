import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbedBuilder } from "discord.js";
import { BRAND } from "../brand.js";
import { ACTOR_ID, CHANNEL_ID, GUILD_ID, TARGET_ID } from "../testing/helpers.js";
import { auditEmbedData, buildAuditEmbed } from "./format.js";
import { createAuditEvent } from "./types.js";

test("uses critical color and caps fields", () => {
  const event = createAuditEvent(
    {
      category: "security",
      type: "security.quarantine",
      severity: "critical",
      summary: "x".repeat(300),
      fields: Array.from({ length: 30 }, (_, index) => ({
        name: `F${index}`,
        value: "v".repeat(1500),
      })),
    },
    GUILD_ID,
    "evt-2",
  );
  const data = auditEmbedData(event);
  assert.equal(data.color, BRAND.colors.red);
  assert.equal(data.title.length, 256);
  assert.equal(data.fields.length, 25);
  assert.equal(data.fields[0]?.value.length, 1024);
});

test("maps each severity to its brand color", () => {
  const colorFor = (severity: "info" | "warn" | "critical"): number =>
    auditEmbedData(
      createAuditEvent(
        { category: "member", type: "member.join", severity, summary: "joined" },
        GUILD_ID,
        "evt-3",
      ),
    ).color;

  assert.equal(colorFor("info"), BRAND.colors.blue);
  assert.equal(colorFor("warn"), BRAND.colors.brass);
  assert.equal(colorFor("critical"), BRAND.colors.red);
});

test("renders actor, target, and channel before event fields", () => {
  const event = createAuditEvent(
    {
      category: "moderation",
      type: "moderation.action",
      summary: "warned a member",
      actor: { id: ACTOR_ID, tag: "actor#0001" },
      target: { id: TARGET_ID, name: "target" },
      channelId: CHANNEL_ID,
      fields: [{ name: "Reason", value: "spam" }],
    },
    GUILD_ID,
    "evt-4",
    new Date("2026-11-09T00:00:00Z"),
  );

  const data = auditEmbedData(event);
  assert.equal(data.author, "WRIGHTYARD / AUDIT · MODERATION");
  assert.equal(data.description, null);
  assert.deepEqual(
    data.fields.map((field) => field.name),
    ["Actor", "Target", "Channel", "Reason"],
  );
  assert.match(data.fields[0]?.value ?? "", /actor#0001/);
  assert.match(data.fields[0]?.value ?? "", new RegExp(ACTOR_ID));
  assert.match(data.fields[2]?.value ?? "", new RegExp(CHANNEL_ID));
  assert.equal(data.footer, `evt-4 · ${BRAND.footer}`);
  assert.equal(data.timestamp.toISOString(), "2026-11-09T00:00:00.000Z");
});

test("builds a Discord embed from the event data", () => {
  const event = createAuditEvent(
    { category: "security", type: "security.alert", severity: "warn", summary: "alert" },
    GUILD_ID,
    "evt-5",
  );

  const embed = buildAuditEmbed(event);
  assert.ok(embed instanceof EmbedBuilder);

  const json = embed.toJSON();
  assert.equal(json.author?.name, "WRIGHTYARD / AUDIT · SECURITY");
  assert.equal(json.title, "alert");
  assert.equal(json.color, BRAND.colors.brass);
  assert.equal(json.footer?.text, `evt-5 · ${BRAND.footer}`);
});
