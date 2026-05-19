#!/bin/sh
# Production start script — runs Next.js + the poller via concurrently, and
# translates SIGTERM/SIGINT-induced exits into a clean exit 0.
#
# Why: Railway sends SIGTERM on every deploy roll. Next.js exits gracefully but
# the *process* still terminates with code 143 (128 + 15 = SIGTERM) because it
# doesn't call process.exit(0). Concurrently surfaces that 143 as the overall
# exit code. Without translation, Railway sees a non-zero exit on every
# graceful shutdown and emails "Deploy Crashed!".
#
# Implementation: trap SIGTERM/SIGINT, forward to the concurrently child, wait
# for it to actually finish, then exit 0 *from within the trap*. Doing the
# exit inside the trap is the critical bit — without it, control returns to
# the main flow where `wait` has already cached the 143 and that leaks out.
#
# Real crashes (any non-zero exit not preceded by a signal) still propagate
# through the bottom `exit $EXIT_CODE` so Railway's restart-on-failure logic
# still catches genuine failures.

cd /app

./node_modules/.bin/concurrently \
  --kill-others-on-fail \
  --names 'web,poll' \
  --prefix-colors 'cyan,magenta' \
  "./node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0" \
  "./node_modules/.bin/tsx src/poller/index.ts" &
PID=$!

# Signal handling — exit 0 inside the trap so the signal-induced 143 never
# reaches the script-level exit.
handle_signal() {
  echo "[start-server] received signal, forwarding to concurrently (pid=$PID)"
  kill -TERM "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  echo "[start-server] concurrently exited, exiting 0"
  exit 0
}
trap handle_signal TERM INT

# Wait for concurrently. If a signal fires, the trap takes over and exits 0.
# If concurrently exits on its own (real crash, healthcheck-triggered restart),
# we propagate its exit code.
wait $PID
EXIT_CODE=$?
exit $EXIT_CODE
