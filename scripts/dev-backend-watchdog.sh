#!/usr/bin/env bash
# Keeps the local Lunora backend (:8788) running.
#
# `wrangler dev` escalates miniflare's "Network connection lost." to a fatal
# process exit (see CLAUDE.md → Local dev), taking the backend down mid-session.
# This loop notices the worker process is gone, moves the output of the run that
# died aside (the next start would otherwise append to it, and its requests
# before the crash would be lost), and starts it again.
#
# It starts `lunora dev --no-codegen`: codegen is not this script's business,
# and running it here would race anyone else regenerating `_generated/`.
#
# Usage:  scripts/dev-backend-watchdog.sh            (foreground; Ctrl+C to stop)
#         It ignores SIGHUP: after closing the terminal, stop it with `pkill -f dev-backend-watchdog`.
# Env:    WATCHDOG_ARCHIVE_DIR  where crashed runs' logs go (default backend/.lunora/crashes)
#         WATCHDOG_RUNNER       `lunora` (default) or `wrangler`. `wrangler` starts the
#                               worker exactly as `lunora dev` does but without its
#                               supervisor, whose readiness probe (1s timeout, every
#                               250ms) is itself a crash trigger while a restarted
#                               worker is still cold. Its log is `$ARCHIVE/wrangler-dev.out`
#                               instead of `lunora-dev.out`.
#
# Logs, all under the archive dir:
#   watchdog.log    this script's lines, including each start's /api/health milestone
#   lunora-dev.out  what `lunora dev` itself printed, stamped
#   startup-ps.log  processes at each launch, then every 30s until the first 200
#   dev-<time>.log  the output of a run that died, moved aside before its restart
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
ARCHIVE="${WATCHDOG_ARCHIVE_DIR:-$BACKEND/.lunora/crashes}"
RUNNER="${WATCHDOG_RUNNER:-lunora}"
# `/_lunora/status` is answered before any setup in `src/server.ts`, so it is
# instant even under load. Probe it with a LONG timeout: a probe that gives up
# on a slow answer leaves a response to be written to a closed socket, which
# crashed wrangler before 4.129.1 (see `src/server.ts` at the status route). The
# bound keeps a stalled answer from holding the loop forever.
HEALTH_URL="http://localhost:8788/_lunora/status"
# The URL Playwright's webServer waits on, and how long it waits. Keep
# STARTUP_WAIT_S in step with the webServer timeout in apps/web/playwright.config.ts.
API_HEALTH_URL="http://localhost:8788/api/health"
STARTUP_WAIT_S=300
# The "still" milestone is written this long after a launch's outage began. One pass
# of the loop can take about 60 s while both probes hang, so it lands before
# Playwright's webServer timeout kills the process group.
STARTUP_LOG_S=$((STARTUP_WAIT_S - 60))
# A launch is protected from restarts until this long after its outage began. Playwright
# has given up well before this, so a launch this slow has already failed the run.
STARTUP_GIVE_UP_S=900

mkdir -p "$ARCHIVE"

# Local time with its UTC offset. `date -Is` is GNU-only: on macOS it fails, and
# the log lines lost their time there.
timestamp() {
    date +%Y-%m-%dT%H:%M:%S%z
}

# stderr too: Playwright shows a webServer's stderr in the CI log, and the log
# upload is missing whenever its artifact download fails.
log() {
    echo "$(timestamp) $*" | tee -a "$ARCHIVE/watchdog.log" >&2
}

# Prefixes each line on stdin with the time it was read, including a last line
# that has no newline yet.
stamp_lines() {
    while IFS= read -r line || [ -n "$line" ]; do
        echo "$(timestamp) $line"
    done
}

# Processes alive while a launch starts, so a launch that prints nothing shows what it is stuck in.
snapshot_processes() {
    {
        echo "$(timestamp) processes"
        # pgrep cannot print the elapsed time or the full command line, which is the point here.
        # shellcheck disable=SC2009
        ps -eo pid,ppid,etime,%cpu,args | grep -E 'lunora|wrangler|workerd|cargo|rustc|worker-build|pnpm|esbuild' | grep -v grep
    } >> "$ARCHIVE/startup-ps.log"
}

# Runs its arguments in a new session, so a closed terminal's SIGHUP does not reach
# the backend (macOS has no setsid, so perl makes the call). Under CI the backend
# stays in Playwright's process group instead, so Playwright's stop takes it down.
detach() {
    if [ -n "${CI:-}" ]; then
        exec "$@"
    fi
    perl -MPOSIX -e 'setsid() or die "setsid: $!"; exec @ARGV' -- "$@"
}

# Stops the backend this watchdog started. `lunora dev` is a managed daemon, so
# ending the watchdog does not end it.
stop_backend() {
    (cd "$BACKEND" && ./node_modules/.bin/lunora dev stop) > /dev/null 2>&1
}

# The output file of the runner in use. Each launch appends to it.
if [ "$RUNNER" = "wrangler" ]; then
    OUT="$ARCHIVE/wrangler-dev.out"
else
    OUT="$ARCHIVE/lunora-dev.out"
fi

# A closed terminal sends SIGHUP to the whole group. This shell ignores it, so the
# output pipes below survive, and `detach` keeps the backend out of the group.
trap '' HUP
trap 'stop_backend; exit 143' TERM
trap 'stop_backend; exit 130' INT

# One probe of `$API_HEALTH_URL` per loop while a launch is starting. The bound
# matches the status probe's, and is long enough that a slow cold start is not
# cut short.
probe_startup() {
    local code

    code="$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$API_HEALTH_URL")"

    if [ "$code" = 200 ]; then
        log "startup: /api/health 200 after $((SECONDS - launched))s"
        starting=0
    elif [ "$milestone_logged" -eq 0 ] && [ "$SECONDS" -ge $((launched + STARTUP_LOG_S)) ]; then
        log "startup: /api/health still $code after ${STARTUP_LOG_S}s"
        milestone_logged=1
    elif [ "$SECONDS" -ge $((launched + STARTUP_GIVE_UP_S)) ]; then
        log "startup: /api/health still $code after ${STARTUP_GIVE_UP_S}s; restarts apply again"
        starting=0
        # The streak that began with this launch ends here. Clearing it makes the next
        # restart count from its own first miss, not from this launch's start.
        fails=0
    fi
}

log "watchdog started ($RUNNER)"

fails=0
# Whether a launch is still waiting for its first 200, and the time its clock started.
starting=0
milestone_logged=0
launched=0
# When the current streak of failed status probes began.
outage_since=0
# When the process snapshot was last taken.
snapshot_at=0

while true; do
    if curl -s -m 30 -o /dev/null "$HEALTH_URL"; then
        fails=0
    else
        if [ "$fails" -eq 0 ]; then
            outage_since=$SECONDS
        fi
        fails=$((fails + 1))
    fi

    # Three missed checks AND no worker process: a slow answer under load is not
    # a crash, and restarting a live-but-busy backend would cause one. Not during a
    # launch either: lunora may not have spawned wrangler yet, so that check would
    # relaunch a backend that is still coming up.
    if [ "$starting" -eq 0 ] && [ "$fails" -ge 3 ] && ! pgrep -f "wrangler.js dev --port 8788" > /dev/null; then
        stamp="$(date +%Y%m%dT%H%M%S)"

        mv "$OUT" "$ARCHIVE/dev-$stamp.log" 2> /dev/null

        log "backend gone — archived dev-$stamp.log, restarting ($RUNNER)"

        # The startup clock began when the outage did, so the misses before this decision
        # and the stop below count against it, as they do against Playwright's clock.
        launched=$outage_since
        (cd "$BACKEND" && timeout 60 ./node_modules/.bin/lunora dev stop > /dev/null 2>&1)

        log "launching ($RUNNER)"
        if [ "$RUNNER" = "wrangler" ]; then
            # The command `lunora dev` itself runs (see `ps` under a lunora dev):
            # the backend's config first, then one `--config` per service in
            # `backend/lunora.config.ts`, so the service bindings resolve in-session.
            (cd "$BACKEND" && detach nohup ./node_modules/.bin/wrangler dev --port 8788 --inspector-port 9235 --var WORKER_ENV:development \
                --config wrangler.jsonc \
                --config ../services/browser-renderer/wrangler.jsonc \
                --config ../services/document-parser/wrangler.jsonc \
                --config ../services/llm-gateway/wrangler.jsonc \
                --config ../services/nsfw-checker/wrangler.jsonc 2>&1 | stamp_lines 2> /dev/null >> "$OUT" &)
        else
            (cd "$BACKEND" && export PATH="./node_modules/.bin:$PATH" && detach nohup lunora dev --no-codegen --worker-port 8788 --inspector-port 9235 2>&1 | stamp_lines 2> /dev/null >> "$OUT" &)
        fi

        starting=1
        milestone_logged=0
        fails=0
        snapshot_processes
        snapshot_at=$SECONDS
    fi

    if [ "$starting" -eq 1 ]; then
        if [ $((SECONDS - snapshot_at)) -ge 30 ]; then
            snapshot_processes
            snapshot_at=$SECONDS
        fi
        probe_startup
    fi

    sleep 3
done
