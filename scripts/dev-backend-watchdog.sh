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

mkdir -p "$ARCHIVE"

log() {
    echo "$(date -Is) $*" | tee -a "$ARCHIVE/watchdog.log"
}

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

        if [ "$RUNNER" = "wrangler" ]; then
            # The command `lunora dev` itself runs (see `ps` under a lunora dev):
            # the backend's config first, then one `--config` per service in
            # `backend/lunora.config.ts`, so the service bindings resolve in-session.
            (cd "$BACKEND" && nohup ./node_modules/.bin/wrangler dev --port 8788 --inspector-port 9235 --var WORKER_ENV:development \
                --config wrangler.jsonc \
                --config ../services/browser-renderer/wrangler.jsonc \
                --config ../services/document-parser/wrangler.jsonc \
                --config ../services/llm-gateway/wrangler.jsonc \
                --config ../services/nsfw-checker/wrangler.jsonc >> "$ARCHIVE/wrangler-dev.out" 2>&1 &)
        else
            (cd "$BACKEND" && PATH="./node_modules/.bin:$PATH" nohup lunora dev --no-codegen --worker-port 8788 --inspector-port 9235 >> "$ARCHIVE/lunora-dev.out" 2>&1 &)
        fi

        for _ in $(seq 1 60); do
            curl -s -m 30 -o /dev/null "$HEALTH_URL" && break
            sleep 2
        done

        log "backend: $(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HEALTH_URL")"
        fails=0
    fi

    sleep 3
done
