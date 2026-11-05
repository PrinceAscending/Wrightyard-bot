#!/bin/sh
set -eu

# Pterodactyl assigns the server's port as SERVER_PORT. The bot only uses it
# for the local health endpoint; the Discord gateway itself is outbound.
if [ -n "${SERVER_PORT:-}" ]; then
  export PORT="$SERVER_PORT"
fi

# The release is self-contained. No install or build step.
exec node index.js
