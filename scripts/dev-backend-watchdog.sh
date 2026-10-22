#!/usr/bin/env bash
# Keeps the local Lunora backend (:8788) running.
#
# `wrangler dev` escalates miniflare's "Network connection lost." to a fatal
# process exit (see CLAUDE.md → Local dev), taking the backend down mid-session.
# This loop notices the worker process is gone, archives the dev log of the run
# that died (`backend/.lunora/dev.log` is truncated on every start, so without
# this the requests that preceded a crash are lost), and starts it again.
#
# It starts `lunora dev --no-codegen`: codegen is not this script's business,
# and running it here would race anyone else regenerating `_generated/`.
#
# Usage:  scripts/dev-backend-watchdog.sh            (foreground; Ctrl+C to stop)
# Env:    WATCHDOG_ARCHIVE_DIR  where crashed runs' logs go (default backend/.lunora/crashes)
#         WATCHDOG_RUNNER       `lunora` (default) or `wrangler`. `wrangler` starts the
#                               worker exactly as `lunora dev` does but without its
#                               supervisor, whose readiness probe (1s timeout, every
#                               250ms) is itself a crash trigger while a restarted
#                               worker is still cold. Its log is `$ARCHIVE/wrangler-dev.out`
#                               instead of `backend/.lunora/dev.log`.
#
# Logs, all under the archive dir:
#   watchdog.log    this script's lines, including each start's /api/health milestone
#   dev-timed.log   backend/.lunora/dev.log with every line stamped as it was read
#   lunora-dev.out  what `lunora dev` itself printed, stamped
#   dev-<time>.log  the dev log of a run that died, copied before its restart
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
ARCHIVE="${WATCHDOG_ARCHIVE_DIR:-$BACKEND/.lunora/crashes}"
RUNNER="${WATCHDOG_RUNNER:-lunora}"
# `/_lunora/status` is answered before any setup in `src/server.ts`, so it is
# instant even under load. Probe it with a LONG timeout: a probe that gives up
# on a slow answer leaves a response to be written to a closed socket, which is
# itself what crashes wrangler 4.124 (see `src/server.ts` at the status route).
HEALTH_URL="http://localhost:8788/_lunora/status"
# The URL Playwright's webServer waits on, and how long it waits. Keep
# STARTUP_WAIT_S in step with the webServer timeout in apps/web/playwright.config.ts.
API_HEALTH_URL="http://localhost:8788/api/health"
STARTUP_WAIT_S=300

mkdir -p "$ARCHIVE"

# Local time with its UTC offset. `date -Is` is GNU-only: on macOS it fails, and
# the log lines lost their time there.
timestamp() {
    date +%Y-%m-%dT%H:%M:%S%z
}

log() {
    echo "$(timestamp) $*" | tee -a "$ARCHIVE/watchdog.log"
}

# Prefixes each line on stdin with the time it was read.
stamp_lines() {
    while IFS= read -r line; do
        echo "$(timestamp) $line"
    done
}

# `lunora dev` sends wrangler's output to dev.log, which has no timestamps. Follow
# it for this watchdog's whole life. `-n 0` skips whatever an earlier run left in
# the file; `-F` picks it up once lunora creates it, and carries on past its truncation.
tail -n 0 -F "$BACKEND/.lunora/dev.log" > >(stamp_lines 2> /dev/null >> "$ARCHIVE/dev-timed.log") 2> /dev/null &
FOLLOWER=$!
trap 'kill "$FOLLOWER" 2> /dev/null' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Waits for the first 2xx from `$API_HEALTH_URL` and logs how long the start took.
# No `-m` on the probe: cutting off a request the backend has accepted is what
# crashes it, so a slow cold start is waited out rather than cut short.
wait_for_api() {
    local launched=$1 code=000

    while [ "$SECONDS" -lt $((launched + STARTUP_WAIT_S)) ]; do
        code="$(curl -s -o /dev/null -w '%{http_code}' "$API_HEALTH_URL")"

        if [ "$code" = 200 ]; then
            log "startup: /api/health 200 after $((SECONDS - launched))s"
            return
        fi

        sleep 2
    done

    log "startup: /api/health still $code after ${STARTUP_WAIT_S}s; no longer waiting"
}

log "watchdog started ($RUNNER)"

fails=0

while true; do
    if curl -s -m 30 -o /dev/null "$HEALTH_URL"; then
        fails=0
    else
        fails=$((fails + 1))
    fi

    # Three missed checks AND no worker process: a slow answer under load is not
    # a crash, and restarting a live-but-busy backend would cause one.
    if [ "$fails" -ge 3 ] && ! pgrep -f "wrangler.js dev --port 8788" > /dev/null; then
        stamp="$(date +%Y%m%dT%H%M%S)"

        if [ "$RUNNER" = "wrangler" ]; then
            mv "$ARCHIVE/wrangler-dev.out" "$ARCHIVE/dev-$stamp.log" 2> /dev/null
        else
            cp "$BACKEND/.lunora/dev.log" "$ARCHIVE/dev-$stamp.log" 2> /dev/null
        fi

        log "backend gone — archived dev-$stamp.log, restarting ($RUNNER)"

        (cd "$BACKEND" && timeout 60 ./node_modules/.bin/lunora dev stop > /dev/null 2>&1)

        launched=$SECONDS
        log "launching ($RUNNER)"
        if [ "$RUNNER" = "wrangler" ]; then
            # The command `lunora dev` itself runs (see `ps` under a lunora dev):
            # the backend's config first, then one `--config` per service in
            # `backend/lunora.config.ts`, so the service bindings resolve in-session.
            (cd "$BACKEND" && nohup ./node_modules/.bin/wrangler dev --port 8788 --inspector-port 9235 --var WORKER_ENV:development \
                --config wrangler.jsonc \
                --config ../services/browser-renderer/wrangler.jsonc \
                --config ../services/document-parser/wrangler.jsonc \
                --config ../services/llm-gateway/wrangler.jsonc \
                --config ../services/nsfw-checker/wrangler.jsonc 2>&1 | stamp_lines 2> /dev/null >> "$ARCHIVE/wrangler-dev.out" &)
        else
            (cd "$BACKEND" && PATH="./node_modules/.bin:$PATH" nohup lunora dev --no-codegen --worker-port 8788 --inspector-port 9235 2>&1 | stamp_lines 2> /dev/null >> "$ARCHIVE/lunora-dev.out" &)
        fi

        wait_for_api "$launched"
        fails=0
    fi

    sleep 3
done
