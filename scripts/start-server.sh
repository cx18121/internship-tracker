#!/bin/sh
# Production start script — bypasses npm/sh wrappers so SIGTERM hits the real
# Node processes (next, tsx) instead of intermediate shells.
#
# Why this matters: every `npm run X` wraps the inner command in `sh -c`, and
# every layer logs `command failed / signal SIGTERM` when killed. With direct
# binary invocation + `exec` we get a clean process tree:
#
#   docker-entrypoint → sh start-server.sh → concurrently
#                                              ├── next       (was: sh -c "exec next")
#                                              └── node/tsx   (was: sh -c "exec tsx")
#
# Both children invoke the real binary via exec so the wrapper sh disappears
# from the tree. SIGTERM lands on next/node directly, runs their handlers
# (poller's is in src/poller/index.ts), and the process exits 0 — no noisy npm
# error during Railway deploys.

set -e
cd /app

exec ./node_modules/.bin/concurrently \
  --kill-others-on-fail \
  --names 'web,poll' \
  --prefix-colors 'cyan,magenta' \
  "exec ./node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0" \
  "exec ./node_modules/.bin/tsx src/poller/index.ts"
