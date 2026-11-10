# Changelog

Notable changes to the Wrightyard bot. The release line is shared with the
website so both can be deployed together.

## [Unreleased]

### Staff, audit logging, and anti-nuke security

#### Added

- Staff rank ladder (`moderator`, `steward`, `admin`, `founder`) with `/staff`
  actions for warn, timeout, kick, ban, unban, purge, lock, unlock, slowmode,
  notes, case lookup, history, stats, and duty.
- `/report` opens a moderation case and posts it to `#mod-log`.
- Staff-only audit category with message, member, server, voice, security,
  moderation, and ticket log channels. History is archived in MongoDB
  (`audit_events`) or `data/audit.ndjson` before feed delivery.
- Native audit-log reconciliation with per-action cursors and a dedupe ledger.
- Anti-nuke rules for channel, role, webhook, emoji, sticker, invite, ban,
  kick, role-assignment, guild-update, bulk-delete, and thread-delete bursts,
  with `alert`, `quarantine`, and `ban` modes.
- Guild snapshots plus role/channel restore for destructive incidents.
- Raid guard that contains young accounts during a join flood before auto-role
  and welcome run.
- `/security status`, `raid`, `snapshot`, and read-only `simulate` subcommands.
- Periodic maintenance that expires moderation cases and closes stale duty
  sessions.

#### Changed

- Bots now receive the roles in `BOT_AUTO_ROLE_IDS` on join (currently
  **TrueForce**), while humans continue to receive `AUTO_ROLE_IDS`
  (**Crew**) and the welcome notice.
- Startup now requires the Message Content privileged intent, plus the
  moderation, invite, voice, expression, webhook, scheduled-event, and
  AutoModeration intents. Presence remains disabled.
- Tickets are linked to the audit service so ticket lifecycle events are
  archived and posted to `#tickets`.

#### Security

- The owner, the bot, and trusted users are never punished by anti-nuke rules.
  Actors at or above the bot are blocked with a critical alert.
- Audit channels deny `@everyone`; the security feed is the only path allowed
  to mention the owner.
- Shutdown flushes security evaluation and the audit queue, then closes every
  store with a per-step timeout.

## [1.1.0] - 2026-11-09

### Added

- Single-file `index.js` release with systemd, Docker, Railway, Fly.io, Render,
  and Pterodactyl packaging.
- Ten guild commands: `admin`, `ask`, `brief`, `help`, `leaderboard`, `rank`,
  `site`, `stats`, `status`, and `ticket`.
- Private tickets with a MongoDB history ledger, auto-role, the XP ladder, and
  level roles.
- Groq-powered `/ask` and `/brief`.
- Signed website heartbeat with presence, maintenance, and command-sync
  overrides.
- Health server at `/health`.

### Security

- Owner checks compare the Discord user ID on every admin subcommand; server
  administrator does not imply owner.
- Staff and ticket-opener checks run at interaction time. Message Content is
  not requested, mentions are locked down, and log fields are redacted.
- Heartbeats require an HMAC-SHA256 signature over the exact raw body.
- Node 20.19+ is supported and the bundle targets Node 20; CI verifies both
  20.19 and 22.12.

### Changed

- Release and Pterodactyl documentation now match the live host: Node 20.19+,
  512 MB RAM or more, and one gateway process.
