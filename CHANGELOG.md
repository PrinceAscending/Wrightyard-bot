# Changelog

Notable changes to the Wrightyard bot. The release line is shared with the
website so both can be deployed together.

## [Unreleased]

### Added

- Bots now receive the roles in `BOT_AUTO_ROLE_IDS` on join (currently
  **TrueForce**), while humans continue to receive `AUTO_ROLE_IDS`
  (**Crew**) and the welcome notice.

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
