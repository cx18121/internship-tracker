#!/usr/bin/env sh
set -e

# Seed/reconcile /app/data against /app/data-defaults via the seed-config helper.
# It merges config files that accrete at runtime (ats-targets.json), overwrites
# pure config files (scoring-config.json, etc.), and leaves runtime state alone.
# See scripts/seed-config.cjs for the per-file strategies.
if [ -f /app/scripts/seed-config.cjs ]; then
  node /app/scripts/seed-config.cjs
fi

# Friendly env-var sanity checks (warn, don't fail — let the process start)
[ -z "$DISCORD_BOT_TOKEN" ]            && echo "[entrypoint] WARN: DISCORD_BOT_TOKEN not set — Discord alerts will be skipped"
[ -z "$DISCORD_CHANNEL_INTERNSHIPS" ]  && echo "[entrypoint] WARN: DISCORD_CHANNEL_INTERNSHIPS not set — Discord alerts will be skipped"

exec "$@"
