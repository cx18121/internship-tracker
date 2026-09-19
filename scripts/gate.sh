#!/usr/bin/env bash
# Full pre-push gate: unit + integration tests against a throwaway Postgres,
# then the Next build. Usage: npm run gate
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=tracker-test-pg
PORT=55432
export DATABASE_URL="postgresql://postgres:postgres@localhost:$PORT/tracker_test"
export DATA_DIR=/tmp/tracker-test-data

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tracker_test -p "$PORT:5432" postgres:16-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

# pg_isready passes during the image's init-time restart; wait for a real query.
for _ in $(seq 1 30); do
  if docker exec "$NAME" psql -U postgres -d tracker_test -qtc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

npm run test:ci
npx next build
echo "GATE_OK"
