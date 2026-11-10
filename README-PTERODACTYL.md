# Wrightyard bot on Pterodactyl

This repository is the complete Wrightyard bot: the Discord gateway, the ticket
ledger, auto-role and the XP ladder, the website heartbeat, and the Groq-powered
`/ask` and `/brief` commands. The release is one self-contained `index.js`; no
`npm install` or build step is needed on the panel.

## 1. Create the server

Use a **Node.js** egg on Node **20.19 or newer** (Node 22 LTS recommended). A
512 MB / 1 vCPU server is enough; 1 GB gives headroom. The bot needs one
long-running process and no inbound web traffic.

Set the startup command to:

```text
node index.js
```

`start.sh` is still included for panels that require a wrapper; it maps
Pterodactyl's `SERVER_PORT` to `PORT` and then runs the same `index.js`.

## 2. Upload the files

1. Open **File Manager** for the server.
2. Upload the release zip.
3. Extract it **into the server root**. The root must contain `index.js`,
   `.env.example`, and `start.sh` directly. If the zip extracts into a folder,
   move its contents up one level.
4. Delete the zip after extraction if the panel has a tight disk quota.

## 3. Create `.env`

Create a file named `.env` in the server root. Copy the values from the
`.env` file on the machine where the bot was built. Do **not** put these values
in a public repository or paste them into chat.

Required:

```dotenv
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
OWNER_ID=...
SITE_URL=https://wrightyard.vercel.app
BOT_HEARTBEAT_SECRET=...
MONGODB_URI=...
MONGODB_DB=wrightyard
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-20b
PORT=8080
NODE_ENV=production
```

Optional but already used by the current yard:

```dotenv
ANNOUNCEMENTS_CHANNEL_ID=...
TICKET_PANEL_CHANNEL_ID=...
TICKET_LOG_CHANNEL_ID=...
STAFF_ROLE_IDS=...
TICKET_CATEGORY_ID=...
AUTO_ROLE_IDS=...
BOT_AUTO_ROLE_IDS=...
LEVEL_ROLE_IDS=...
WELCOME_CHANNEL_ID=...
LEVEL_UP_CHANNEL_ID=...
```

Staff, audit, and security:

```dotenv
# Staff tiers. Highest matching tier wins; OWNER_ID is always founder.
STAFF_FOUNDER_ROLE_IDS=1566787080439337103
STAFF_ADMIN_ROLE_IDS=1566787076458815621
STAFF_STEWARD_ROLE_IDS=1567499945492353064
STAFF_MODERATOR_ROLE_IDS=1567499947526459486

# Audit routing. Leave blank on the first boot so the bot creates the
# staff-only "audit" category and six log channels, then copy the IDs back
# here and restart once.
LOG_CATEGORY_ID=
LOG_CHANNEL_ID=
MESSAGE_LOG_CHANNEL_ID=
MEMBER_LOG_CHANNEL_ID=
SERVER_LOG_CHANNEL_ID=
VOICE_LOG_CHANNEL_ID=
SECURITY_LOG_CHANNEL_ID=
MOD_LOG_CHANNEL_ID=
LOG_MESSAGE_CONTENT=true
AUDIT_RETENTION_DAYS=0

# Anti-nuke. Start with alert for the first boot, then quarantine.
ANTINUKE_ENABLED=true
ANTINUKE_MODE=quarantine
ANTINUKE_TRUSTED_USER_IDS=
ANTINUKE_QUARANTINE_ROLE_ID=
ANTINUKE_RESTORE=true

# Raid guard.
RAID_GUARD_ENABLED=true
RAID_JOIN_THRESHOLD=8
RAID_WINDOW_SECONDS=60
RAID_MIN_ACCOUNT_AGE_DAYS=7
RAID_MODE_MINUTES=10

# Snapshot cadence in minutes.
SNAPSHOT_INTERVAL_MINUTES=360
```

Message Content is a **privileged intent**. Enable it in the Discord Developer
Portal under **Bot → Privileged Gateway Intents**. Server Members must also be
enabled. Presence must stay off. If Message Content is disabled, set
`LOG_MESSAGE_CONTENT=false`; message edit/delete events will then store metadata
without text.

The current production values are documented in `.env.example`. Copy them, not
the file itself, and keep the secrets out of the repository.

`BOT_HEARTBEAT_SECRET` must be the exact same value as the website's
`BOT_HEARTBEAT_SECRET` in Vercel. If it differs, the bot runs but the website
will keep showing it as offline.

If the panel lets you define environment variables in the **Startup** tab, you
can use that instead of `.env`. Process environment variables win over `.env`.

## 4. First start

Start the server and watch the console. A healthy boot looks like this:

```text
INFO  [bot] Commands loaded {"count":10,...}
INFO  [bot] AI bench ready {"model":"openai/gpt-oss-20b"}
INFO  [bot] Gateway ready ...
INFO  [bot] Community systems ready {"autoRoles":1,"levelRoles":4,...}
INFO  [bot] Yard located ...
INFO  [bot:tickets] Ticket ledger rehydrated ...
INFO  [bot:heartbeat] Website heartbeat started ...
INFO  [bot:heartbeat] Website heartbeat accepted
```

There is no dependency install or build step. If startup fails, check that
`index.js` is in the server root and that Node is 20.19 or newer.

## 5. Register the commands

The bot registers commands when the website asks it to sync, or you can do it
once from the Pterodactyl console:

```bash
node index.js --deploy-commands
```

You should see ten commands:

```text
admin, ask, brief, help, leaderboard, rank, site, stats, status, ticket
```

If they do not appear in Discord, wait a minute and reload the client. The
owner can also run `/admin sync` in the server.

## 6. Verify the integration

1. Run `/status` in Discord. It should answer with a live embed.
2. Run `/ask what does wrightyard build?`. It should answer through Groq.
3. Run `/brief I need a Discord bot for a gaming community with tickets and
   moderation.` It should return a private draft.
4. Run `/rank` and `/leaderboard` to confirm the XP ledger is live.
5. Join with a test account and confirm **Crew** is assigned and the welcome
   card lands in `#welcome`.
6. Open `https://wrightyard.vercel.app/api/status`. The bot should show
   `online: true` within 30 seconds.
7. Open a ticket from `#open-a-ticket` and close it to confirm the ledger and
   ticket log still work.

## 7. Keep exactly one process

A Discord gateway bot must run once. Before starting the Pterodactyl server,
stop the bot on the old machine. Two copies will fight over presence and
heartbeats, and Discord may disconnect both. The audit reconciler, raid guard,
and security state assume a single writer; a second process can duplicate
alerts and quarantine decisions.

If the panel has a "restart on crash" or "auto restart" setting, leave it on.
Do not run a second copy as a backup.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `DISCORD_TOKEN is missing` | The `.env` file is not in the server root, or the panel environment is empty. |
| `Gateway ready` never appears | The token is wrong, the bot is not invited, or one of the required intents is off in the Discord Developer Portal. Server Members and Message Content are both required. |
| Commands missing | Run `node index.js --deploy-commands` and confirm `DISCORD_GUILD_ID` is the Wrightyard guild. |
| Website says bot offline | `SITE_URL` must be `https://wrightyard.vercel.app`; `BOT_HEARTBEAT_SECRET` must match Vercel exactly. Check the console for `Website heartbeat accepted`. |
| `/ask` says AI is not wired | `GROQ_API_KEY` is missing or still the placeholder. |
| `node index.js` fails immediately | Use Node 20.19+, confirm `index.js` is in the server root, and check the console for the exact error. |
| Health check fails | The bot listens on `PORT` (default `8080`). If the panel assigns a different port, `start.sh` maps `SERVER_PORT` to `PORT` automatically. |

## Security

- Treat `DISCORD_TOKEN`, `MONGODB_URI`, `BOT_HEARTBEAT_SECRET`, and
  `GROQ_API_KEY` as passwords.
- The Groq key pasted during setup should be rotated once the new host is
  confirmed working. Create a fresh key at <https://console.groq.com/keys>,
  update `.env`, and restart.
- Never commit `.env`, logs, or the zip containing secrets.
