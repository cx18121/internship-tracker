#!/usr/bin/env sh
set -e

# Seed /app/data (volume mount point) from /app/data-defaults if files missing.
# Config files (companies.yml, scoring-config.json, ats-targets.json, etc.) get
# the in-image defaults; runtime state (internships.json, seen.json, etc.)
# accumulates in the volume across redeploys.
if [ -d /app/data-defaults ]; then
  mkdir -p /app/data
  for src in /app/data-defaults/*; do
    name=$(basename "$src")
    if [ ! -e "/app/data/$name" ]; then
      cp -r "$src" "/app/data/$name"
      echo "[entrypoint] seeded data/$name from defaults"
    fi
  done
fi

# Friendly env-var sanity checks (warn, don't fail — let the process start)
[ -z "$DISCORD_BOT_TOKEN" ]            && echo "[entrypoint] WARN: DISCORD_BOT_TOKEN not set — Discord alerts will be skipped"
[ -z "$DISCORD_CHANNEL_INTERNSHIPS" ]  && echo "[entrypoint] WARN: DISCORD_CHANNEL_INTERNSHIPS not set — Discord alerts will be skipped"

exec "$@"
