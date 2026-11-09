# Wrightyard bot

The Discord gateway for [Wrightyard](https://wrightyard.vercel.app): a software
studio and an after-hours crew. The bot runs the public commands, private
tickets, community roles, the XP ladder, owner controls, and the signed
heartbeat that keeps the website's live report honest.

- **Runtime:** Node.js 20.19+ (22.12+ recommended; Docker uses `node:22-alpine`)
- **Release:** one self-contained root `index.js`; run `node index.js`
- **Library:** `discord.js` 14
- **Language:** TypeScript source, bundled to CommonJS for the release
- **Intents:** `Guilds`, `GuildMembers`, `GuildMessages` — **Message Content is off**
- **State:** MongoDB for tickets and XP; channel topics and `data/levels.json` are the fallbacks
- **Process:** exactly one long-running gateway process

## The three-part system

| Part | Where | Role |
| --- | --- | --- |
| Website | <https://wrightyard.vercel.app> | Public studio site, member dashboard, live status, job briefs, owner bench |
| Discord server | <https://discord.gg/6m6e5aFkyh> | The yard: community, tickets, roles, and the XP ladder |
| Bot | this repository | Keeps the server moving and reports its pulse to the website |

All three share one vocabulary: **Wrightyard**, “Built here. Kept running.”,
the same public commands, the same role ladder, and the same channel names.
The bot and website can share one MongoDB database (`wrightyard`). The site
never needs to be online for Discord tickets to work.

## What it does

| Area | Behavior |
| --- | --- |
| Public commands | `/status`, `/stats`, `/site`, `/rank`, `/leaderboard`, `/ask`, `/brief`, `/help`, `/ticket` |
| Owner commands | `/admin status`, `announce`, `presence`, `maintenance`, `sync`, `ticketpanel` |
| Auto-role | Every new human receives **Crew** on join |
| Welcome | A branded welcome card is posted in `#welcome` with links to the rules, roles, and ticket desk |
| XP | 15–25 XP per eligible message, 60-second cooldown, `20 × level²` total XP, max level 100 |
| Level roles | **Apprentice** at 5, **Journeyman** at 15, **Craftsman** at 30, **Master** at 50; lower ladder roles are removed as members climb |
| Level-ups | A notice is posted in `#ship-log` |
| Tickets | Private channels, one open ticket per user, claim, close, delete, log, MongoDB history |
| AI bench | `/ask` answers studio questions; `/brief` drafts a scoped job. Groq-powered; cleanly disabled without a key |
| Presence | Five-state rotation, website override, local owner override, maintenance idle state |
| Heartbeat | Signed `POST` to `${SITE_URL}/api/bot/heartbeat` every 30 seconds |
| Health | `GET /health` and `GET /` on `PORT` (default `8080`) |

XP is not granted in `#commands`, ticket rooms, `#staff`, `#mod-log`, or client
rooms. The bot ignores other bots and system messages. Message Content is never
requested; XP only needs message metadata.

## Quick start

### From the release zip

The release contains `index.js`, `.env.example`, and the runbooks. There is no
install or build step:

```bash
cp .env.example .env
# fill in the real values
node index.js
```

On first setup, register the slash commands once:

```bash
node index.js --deploy-commands
```

Then start the bot with `node index.js`. Open
<http://localhost:8080/health>. A healthy process reports `"ok": true` once the
gateway is ready.

### From source

On Linux, macOS, or WSL:

```bash
npm ci
cp .env.example .env.local
# fill in the real values
npm run build
npm run deploy-commands
npm start
```

On Windows PowerShell:

```powershell
npm ci
Copy-Item .env.example .env.local
# fill in the real values
npm run build
npm run deploy-commands
npm start
```

Build the standalone bundle yourself with `npm run bundle`. That writes
`index.js`, which is the same file shipped in the release.

The loader reads `.env.local` first, then `.env`. Values already present in the
process environment win, which is how systemd, Docker, Railway, Fly, Render, and
Pterodactyl inject secrets. Set `WRIGHTYARD_ENV_FILE` to load one extra file
before the local ones (used by the systemd deploy step below).

### Register slash commands

Commands are **not** deployed on `ready`. Register them after a release or
build:

```bash
# Release zip:
node index.js --deploy-commands

# Source checkout:
npm run deploy-commands
```

This writes the guild-scoped command set to `DISCORD_GUILD_ID`. Deploy to a test
guild first when changing commands. After that, the owner can run `/admin sync`
or queue a sync from the website’s owner bench; the bot picks it up on its next
heartbeat.

## Discord application setup

1. Create or open the application in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot → Privileged Gateway Intents** and enable **Server Members
   Intent**. Leave **Message Content Intent** and **Presence Intent** off.
3. Invite the bot with the `bot` and `applications.commands` scopes.
4. Keep exactly one running copy. Two gateway processes fight over presence and
   heartbeats.

### Permissions

Grant these guild permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Attach Files
- Manage Channels
- Manage Roles
- Manage Messages

`Administrator` is **not** required. The bot role must sit above the roles it
assigns (the level ladder and any staff roles it edits). The current managed
`WrightForge` role may still carry Administrator until the guild owner trims it
in **Server Settings → Roles**; the bot cannot edit its own managed role.

### Channel setup

Set the IDs in the environment. Optional channels can be left empty, but the
related feature will be disabled or fall back to a name lookup:

- `ANNOUNCEMENTS_CHANNEL_ID` — owner announcements
- `TICKET_PANEL_CHANNEL_ID` — where `/admin ticketpanel` posts
- `TICKET_LOG_CHANNEL_ID` — ticket closures, deletions, and failures
- `TICKET_CATEGORY_ID` — private ticket category
- `WELCOME_CHANNEL_ID` — join notices
- `LEVEL_UP_CHANNEL_ID` — level-up notices

The bot needs View Channel, Send Messages, and Embed Links in the panel,
announcement, welcome, and level-up channels.

## Environment

Copy `.env.example` and fill every required value. Never commit real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Bot token. Never log, commit, or paste it into chat. |
| `DISCORD_CLIENT_ID` | Yes | Application/client ID used by the deploy script. |
| `DISCORD_GUILD_ID` | Yes | The one guild this process serves. |
| `OWNER_ID` | Yes | Discord user ID allowed to run `/admin`. A role or guild administrator does not imply owner. |
| `SITE_URL` | Recommended | Public site origin, for example `https://wrightyard.vercel.app`. Used for links and the heartbeat. |
| `BOT_HEARTBEAT_SECRET` | Recommended | Shared HMAC secret. Must exactly match the website’s value. |
| `ANNOUNCEMENTS_CHANNEL_ID` | Optional | Default target for `/admin announce`. |
| `TICKET_PANEL_CHANNEL_ID` | Optional | Where `/admin ticketpanel` posts. Falls back to `#open-a-ticket`. |
| `TICKET_LOG_CHANNEL_ID` | Optional | Closure, deletion, and failure notices. |
| `TICKET_CATEGORY_ID` | Optional | Existing private category. When empty, the bot uses or creates `Tickets`. |
| `STAFF_ROLE_IDS` | Recommended | Comma-separated role IDs that can see and claim tickets. Ticket opening refuses while empty. |
| `AUTO_ROLE_IDS` | Recommended | Comma-separated roles applied to every new human. |
| `LEVEL_ROLE_IDS` | Recommended | `level:roleId` pairs. The highest reached role is kept. |
| `WELCOME_CHANNEL_ID` | Optional | Join notice destination. |
| `LEVEL_UP_CHANNEL_ID` | Optional | Level-up notice destination. |
| `LEVELS_FILE` | Optional | JSON ledger path when MongoDB is unavailable. |
| `MONGODB_URI` | Recommended | MongoDB Atlas SRV URI. Required for durable tickets and XP. |
| `MONGODB_DB` | Optional | Database name. Defaults to `wrightyard`. |
| `GROQ_API_KEY` | Optional | Enables `/ask` and `/brief`. Leave empty to run without AI. |
| `GROQ_MODEL` | Optional | Groq model name. Defaults to `openai/gpt-oss-20b`. |
| `PORT` | Optional | Health-server port. Defaults to `8080`. |

`SITE_URL` and `BOT_HEARTBEAT_SECRET` must either both be real or both be
absent. The example placeholders are detected and disable the heartbeat with a
warning instead of sending invalid requests. `BOT_HEARTBEAT_SECRET` must be at
least 32 characters.

Generate a secret without sending it anywhere:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the same value in the bot host and in the website’s environment.

## Commands

### Public

| Command | Description |
| --- | --- |
| `/status` | Maintenance state, gateway ping, uptime, members, open tickets, commands served, site links |
| `/stats` | Members, approximate present members, channels, roles, boosts, guild age, open tickets |
| `/site` | Links to the website, dashboard, status page, and Discord invite |
| `/rank [member]` | Level, XP progress, message count, and standing |
| `/leaderboard` | The top ten of the XP ledger |
| `/ask` | Groq-powered answer about the studio, services, or process |
| `/brief` | Groq-powered private draft with the job, build shape, open questions, and a first move |
| `/help` | Command index; includes owner commands only for the owner |
| `/ticket` | Ephemeral ticket panel with an **Open a ticket** button |

All commands are guild-only. Cooldowns are in memory and per user per command
(2–10 seconds depending on the command).

### Owner only

`/admin` is registered with `default_member_permissions = Administrator` so it
is hidden from ordinary members. The owner check is repeated on every
subcommand; a guild administrator who is not `OWNER_ID` receives an ephemeral
“Owner only” refusal.

| Subcommand | Description |
| --- | --- |
| `/admin status` | Process, memory, gateway, ticket, heartbeat, presence, and maintenance readings |
| `/admin announce title message [channel]` | Branded announcement; defaults to the announcements channel |
| `/admin presence text status` | Local rich-presence override (`online`, `idle`, `dnd`, `invisible`) |
| `/admin maintenance enabled` | Local maintenance toggle; closes ticket intake and sets idle presence |
| `/admin sync` | Re-register the guild command set immediately |
| `/admin ticketpanel` | Post or refresh the panel in the configured panel channel |

Presence precedence, highest first:

1. Maintenance: idle, “Down for maintenance”
2. Website heartbeat override
3. Local `/admin presence` override
4. Five-state rotation

## Community systems

### Auto-role and welcome

On `GuildMemberAdd`, the bot adds every role in `AUTO_ROLE_IDS` (currently
**Crew**) and posts a welcome embed in `WELCOME_CHANNEL_ID` with link buttons to
the rules, role picker, and ticket desk. Bots are ignored. A missing role or
channel is logged and never blocks the rest of the join flow.

### XP and levels

- **Gain:** random 15–25 XP per eligible message.
- **Cooldown:** one gain per user per 60 seconds. The cooldown is in memory and
  resets on restart.
- **Curve:** total XP for level `L` is `20 × L²`. Level 5 needs 500 XP, level 15
  needs 4,500, level 30 needs 18,000, level 50 needs 50,000.
- **Cap:** level 100.
- **Storage:** MongoDB collection `levels`, keyed by guild and user. If MongoDB
  is unavailable, the bot falls back to `data/levels.json` (or `LEVELS_FILE`).
- **Roles:** the highest configured role reached is kept; lower ladder roles are
  removed. Missing roles and roles above the bot are logged, not fatal.
- **Announcements:** level-ups post to `LEVEL_UP_CHANNEL_ID` with the new level,
  total XP, and message count.

`/rank` and `/leaderboard` read the same ledger. The site’s command index lists
both commands so the three properties stay in sync.

## Tickets

### Opening

`/admin ticketpanel` posts a persistent panel with a single **Open a ticket**
button. The button is also available ephemerally through `/ticket`.

When a member presses **Open a ticket**:

1. Maintenance and staff configuration are checked.
2. A 30-second per-user cooldown is checked.
3. The category is resolved by ID, then by the name `Tickets`, then created.
4. The ledger is checked for any open ticket by that member, including tickets
   found by scanning channel topics.
5. Creation is serialized so two clicks cannot allocate the same number or
   create two rooms.
6. A private text channel is created under the category.

Channel name:

```text
ticket-0001-username
```

Channel topic:

```text
Wrightyard ticket #0001 · opener 123456789012345678 · open
```

Permission overwrites:

- `@everyone`: deny View Channel
- Opener: allow View Channel, Send Messages, Read Message History, Attach Files
- Each configured staff role: the same allow set
- Bot: View Channel, Send Messages, Read Message History, Attach Files, Manage
  Channels, Embed Links, Manage Messages

The intro embed records the opener, claim state, and open time, with **Claim
ticket** and **Close ticket** buttons.

### Claiming, closing, deleting

- **Claim** rechecks the staff role at click time, records the claim in the topic
  and intro embed, and announces it in the channel.
- **Close** is available to the opener or staff. It shows an ephemeral
  confirmation first. Confirming sets the topic and name to closed, removes the
  opener’s Send Messages permission, updates the intro, posts a closed note with
  a delete control, and sends a log embed when `TICKET_LOG_CHANNEL_ID` is set.
- **Delete** is staff-only and requires the ticket to be closed. It shows an
  ephemeral confirmation first. Confirming writes a deletion log, removes the
  ledger entry, and deletes the channel.

All button actions repeat the owner/staff/opener checks. The handler also checks
the bot’s current channel permissions before claiming, closing, or deleting.

### Ledger and restart behavior

- Open ticket state is mirrored in MongoDB collection `tickets` for the website’s
  owner bench and member files.
- Channel topics remain the recovery source. On startup the bot scans the ticket
  category and rebuilds open state from topics and `closed-` names.
- A Mongo outage never blocks opening, claiming, closing, or deleting; the bot
  logs the failure, backs off, and keeps the Discord-side record.
- Ticket numbers continue from the highest number found at startup. A deleted
  channel can release its number if no other ticket is above it.
- Exactly one gateway process should run.

## Website heartbeat

The bot sends a heartbeat every 30 seconds to:

```text
POST ${SITE_URL}/api/bot/heartbeat
```

Headers:

```text
content-type: application/json
x-wrightyard-signature: <hex HMAC-SHA256 of the exact raw JSON body>
user-agent: WrightyardBot/<version>
```

The HMAC key is `BOT_HEARTBEAT_SECRET`. The signature is lowercase hex of the
digest. The exact serialized string that is signed is the exact request body; do
not re-serialize the payload after signing.

Request body:

```json
{
  "botId": "1566784935342252032",
  "version": "1.1.0",
  "startedAt": "2026-11-02T13:00:00.000Z",
  "uptimeSeconds": 3600,
  "ping": 42,
  "guilds": 1,
  "members": 120,
  "commandsServed": 18,
  "openTickets": 2,
  "presence": "the gate",
  "maintenance": false,
  "memoryMb": 96,
  "lastCommandAt": "2026-11-02T13:42:00.000Z"
}
```

Response body used by the bot:

```json
{
  "ok": true,
  "presence": "the gate",
  "status": "online",
  "maintenance": null,
  "syncCommands": false
}
```

- `presence: null` clears the website presence override.
- `status` is one of `online`, `idle`, `dnd`, `invisible`; `null` clears it.
- `maintenance: true|false` sets the website override; `null` clears it.
- `syncCommands: true` re-registers guild commands on this heartbeat, at most
  once per 60 seconds.
- A failed heartbeat never stops the bot. Failures are logged at most every five
  minutes and are visible in `/admin status`.

## Health server

The process listens on `0.0.0.0:${PORT}` (default `8080`).

```text
GET /health
GET /
```

Response:

```json
{
  "ok": true,
  "uptimeSeconds": 3600,
  "ready": true,
  "guilds": 1,
  "version": "1.1.0"
}
```

- `503` with `ok: false` until the gateway is ready.
- `200` with `ok: true` after the client is ready.
- `HEAD` is supported. Other methods return `405`.
- No secrets, tokens, guild names, or member data are exposed.

## Deployment

The bot must run on a persistent Linux host. Vercel functions cannot hold a
24/7 gateway connection or rich presence.

### Linux with systemd (recommended)

This is the plain-metal path: Node runs the bundled `index.js`, and systemd
keeps exactly one process alive.

Requirements: a Debian/Ubuntu (or similar) server, Node.js 20.19+, Git, and a
non-root service user.

```bash
# 1. Create the service user and directories.
sudo adduser --system --group --home /var/lib/wrightyard-bot wrightyard
sudo mkdir -p /opt/wrightyard-bot /etc/wrightyard-bot
sudo chown wrightyard:wrightyard /opt/wrightyard-bot

# 2. Get the release. The repository contains the built index.js, so no npm
#    install or build is needed. (A release zip works the same way.)
sudo -u wrightyard -H git clone --depth 1 \
  https://github.com/PrinceAscending/Wrightyard-bot.git /opt/wrightyard-bot

# 3. Create the environment file. Readable by the service user only.
sudo install -m 640 -o root -g wrightyard \
  /opt/wrightyard-bot/.env.example /etc/wrightyard-bot/wrightyard-bot.env
sudo nano /etc/wrightyard-bot/wrightyard-bot.env

# 4. Register commands once. WRIGHTYARD_ENV_FILE points the release at the
#    systemd-managed env file.
sudo -u wrightyard -H env \
  WRIGHTYARD_ENV_FILE=/etc/wrightyard-bot/wrightyard-bot.env \
  /usr/bin/node /opt/wrightyard-bot/index.js --deploy-commands

# 5. Install and start the service.
sudo cp /opt/wrightyard-bot/deploy/wrightyard-bot.service \
  /etc/systemd/system/wrightyard-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now wrightyard-bot

# 6. Verify.
systemctl status wrightyard-bot
journalctl -u wrightyard-bot -f
curl -fsS http://127.0.0.1:8080/health
```

The unit uses `EnvironmentFile=/etc/wrightyard-bot/wrightyard-bot.env`, so the
secrets never live in the repository. If the bot writes the JSON fallback
ledger, ensure `/opt/wrightyard-bot/data` is writable by `wrightyard`.

For updates, replace `index.js` and restart. With a Git checkout:

```bash
cd /opt/wrightyard-bot
sudo -u wrightyard -H git pull --ff-only
sudo systemctl restart wrightyard-bot
```

Only one process may hold the Discord gateway. Stop any old process before
starting the unit.

### Docker

```powershell
docker build -t wrightyard-bot .
docker run --rm --env-file .env -p 8080:8080 wrightyard-bot
```

The image builds the same standalone `index.js`, runs as the non-root `node`
user, needs no production `node_modules`, and includes a health check.

### Docker Compose

```powershell
Copy-Item .env.example .env
# fill in the real values
docker compose up -d --build
```

### Railway

1. Create a Railway project from this repository.
2. Railway uses the `Dockerfile` at the repo root.
3. Add every environment variable in the service’s Variables tab.
4. Keep exactly **one replica**.
5. Deploy and check `GET /health`.
6. Register commands once with `node index.js --deploy-commands` from a trusted
   machine, or use `/admin sync` after the first deploy.

`railway.json` points Railway at the Dockerfile and `/health` with an
`ON_FAILURE` restart policy.

### Fly.io

Change `app` and `primary_region` in `fly.toml`, then set secrets through the Fly
dashboard or CLI:

```powershell
fly secrets set DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=...
fly secrets set OWNER_ID=... SITE_URL=... BOT_HEARTBEAT_SECRET=...
fly secrets set ANNOUNCEMENTS_CHANNEL_ID=... TICKET_PANEL_CHANNEL_ID=...
fly secrets set TICKET_LOG_CHANNEL_ID=... STAFF_ROLE_IDS=... TICKET_CATEGORY_ID=...
fly deploy
```

Do not enable autostop; a stopped machine cannot hold the Discord gateway or
rotate presence.

### Pterodactyl

See [`README-PTERODACTYL.md`](./README-PTERODACTYL.md). In short:

1. Create a Node.js server on Node 20.19+ with 512 MB RAM; 1 GB gives headroom.
2. Upload the release zip and extract it so `index.js` sits in the server root.
3. Create `.env` with the values from the environment table.
4. Start with `node index.js` (or `sh start.sh`), run
   `node index.js --deploy-commands` once, then verify `/health`, `/status`, and
   `Website heartbeat accepted`.
5. Stop any old bot process first. One gateway process only. There is no
   `npm install` or build step.

### Any other host

Any persistent process host works. The requirements are:

- Node.js 20.19+
- One long-running process
- Environment variables from the table above
- A routed port equal to `PORT`
- A health check on `/health`
- No serverless request timeout

## Operations

### Logging

Logs are line-oriented: timestamp, level, scope, message, and an optional JSON
field object. Sensitive field names (`token`, `secret`, `signature`,
`authorization`, `cookie`) are redacted before serialization. Errors are logged
with name, message, stack, and Discord error code/status when available.

### Shutdown

`SIGINT` and `SIGTERM` stop the heartbeat and presence timers, abort an in-flight
heartbeat, close the health server, close Mongo clients, destroy the Discord
client, and exit. A 10-second timer forces exit if cleanup hangs.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `DISCORD_TOKEN is missing.` | The env file is not in the project root or the host variable is absent. |
| Commands do not appear | Run `node index.js --deploy-commands` (or `npm run deploy-commands` from source) against the correct `DISCORD_GUILD_ID`; allow Discord a moment; use `/admin sync`. |
| `/admin` is hidden | It is registered for Administrators and refuses non-owners. Confirm both the guild permission and `OWNER_ID`. |
| Ticket opening says intake is not configured | `STAFF_ROLE_IDS` is empty or none of the IDs exist in the guild. |
| Ticket creation fails | Confirm Manage Channels and Manage Roles, and that the bot role is above the staff roles. |
| Auto-role does nothing | Enable **Server Members Intent** in the Developer Portal and confirm the `Crew` role ID. |
| No XP | Messages must be in an eligible channel and at least 60 seconds apart. Bots do not earn XP. |
| Level role not assigned | Confirm the role ID, that it sits below the bot role, and that the member actually leveled up. |
| Heartbeat 401 | `BOT_HEARTBEAT_SECRET` differs between bot and website, or a proxy rewrote the request body. |
| Heartbeat 422 | The website’s heartbeat schema rejected a field; check the response in the bot logs. |
| `/health` returns 503 | The gateway has not reached ready; check `/admin status` or logs for login/intent errors. |
| Bot appears offline after a while | Ensure the host is not autostopping. |

## Security notes

- The bot token is read only from `DISCORD_TOKEN`; it is never hardcoded,
  printed, or included in health output.
- The owner check compares the interacting user ID to `OWNER_ID` on every admin
  subcommand. Server administrator does not imply owner.
- Staff and opener checks run at interaction time, not only when the panel was
  posted.
- Ticket channel creation and closing check current bot permissions.
- No `eval`, shell execution, arbitrary user-supplied URLs, or dynamic imports
  from user input.
- `allowedMentions: { parse: [] }` is the client default and is set explicitly
  on outgoing messages, so announcements and ticket notices cannot ping
  `@everyone`.
- Message Content is not requested. XP uses message metadata only.
- Secrets belong in `.env` / `.env.local` on the host or the host’s secret manager. `.env*` is ignored
  except `.env.example`, and `.dockerignore` keeps env files out of the image.

If a token, MongoDB URI, heartbeat secret, or Groq key has ever been exposed,
rotate it in the relevant dashboard and update both the bot host and the website
before production. Rotating the heartbeat secret requires updating both
deployments together.

## Project layout

```text
index.js            self-contained release bundle; run with node index.js
src/
  admin/            owner subcommand implementations
  commands/         slash command modules
  interactions/     command/button routing and safe replies
  services/         presence, heartbeat, health, command sync, levels, community, AI
  tickets/          ledger, topic schema, lifecycle, Mongo history
  views/            embeds and component rows
  config.ts         environment parsing and validation
  index.ts          boot, ready, shutdown
  deploy.ts         command registration
  deploy-commands.ts CLI wrapper
scripts/
  bundle.mjs        builds index.js
  smoke.mjs         health and signed-heartbeat checks
  check-version.mjs keeps package.json and src/version.ts aligned
Dockerfile
docker-compose.yml
railway.json
fly.toml
.env.example
package.json
package-lock.json
tsconfig.json
```

## Verification

Run locally:

```powershell
npm run typecheck
npm run check-version
npm run build
npm run smoke
npm run bundle
npm run bundle:check
```

`npm run smoke` starts a stubbed health server and a local signed-heartbeat
receiver. It verifies the 503/200 health responses, the exact HMAC over the raw
request body, website presence and maintenance conversion, website-override
clearing, and the sync flag. It does not connect to Discord.

`npm run bundle` writes the release `index.js`; `npm run bundle:check` verifies
that the output parses. `npm run check-version` keeps `package.json` and the
version embedded in the bundle aligned.

Live verification still requires a real setup:

- A Discord bot token and a **development** guild
- A command deployment to that development guild
- Running `/status`, `/stats`, `/site`, `/rank`, `/leaderboard`, `/help`,
  `/ticket`, and the owner subcommands in the guild
- Clicking through ticket open, claim, close, and delete
- Confirming a non-owner is refused by `/admin`
- Confirming a member without a staff role cannot claim or delete
- Joining with a test account to confirm **Crew** and the welcome card
- Sending eligible messages to confirm XP, the cooldown, and a level-up notice
- A signed heartbeat accepted by the website and a delivered presence override

Those checks should be done in a test guild before pointing the deployment at
the production guild.

## Links

- Website: <https://wrightyard.vercel.app>
- Status: <https://wrightyard.vercel.app/status>
- Dashboard: <https://wrightyard.vercel.app/dashboard>
- Discord: <https://discord.gg/6m6e5aFkyh>
- Bot repository: <https://github.com/PrinceAscending/Wrightyard-bot>
- Website repository: <https://github.com/PrinceAscending/Wrightyard-web>
