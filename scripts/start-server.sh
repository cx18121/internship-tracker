#!/bin/sh
# Production start script — runs Next.js + the poller via concurrently, and
# translates SIGTERM/SIGINT-induced exit codes (143 / 130) into a clean exit 0.
#
# Why: Railway sends SIGTERM on every deploy roll. Next.js exits gracefully but
# the *process* still terminates with code 143 (128 + 15 = SIGTERM) because it
# doesn't call process.exit(0). The poller's own SIGTERM handler exits 0
# correctly. Concurrently surfaces the first non-zero child exit, so we end up
# at 143 → Railway sees "deploy crashed" → email.
#
# Any *other* non-zero exit (uncaught exception, OOM, etc.) is a real crash and
# still propagates up to Railway's restart-on-failure logic.

cd /app

./node_modules/.bin/concurrently \
  --kill-others-on-fail \
  --names 'web,poll' \
  --prefix-colors 'cyan,magenta' \
  "./node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0" \
  "./node_modules/.bin/tsx src/poller/index.ts" &
PID=$!

# Forward Railway's SIGTERM (and local Ctrl-C SIGINT) to concurrently so its
# children get the signal and can shut down. Without this, kill -TERM hitting
# sh would orphan concurrently.
trap 'kill -TERM $PID 2>/dev/null' TERM
trap 'kill -INT  $PID 2>/dev/null' INT

# wait can be interrupted by the signal — re-wait until concurrently actually
# exits and we have a real exit code.
while kill -0 $PID 2>/dev/null; do
  wait $PID
  CODE=$?
done

# 143 = SIGTERM (Railway graceful shutdown)
# 130 = SIGINT (local Ctrl-C)
if [ "$CODE" = "143" ] || [ "$CODE" = "130" ]; then
  exit 0
fi
exit "$CODE"
