# LOCAL DEV

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## Local dev

- **Mail never leaves the machine in `lunora dev`.** `@lunora/mail`
  (`backend/lunora/email/mailer.ts`) captures every send into the studio's
  **Mail** tab — verification links, resets, OTPs, invites. Capture keys off
  `ENVIRONMENT=development` / lunora dev's `WORKER_ENV`, not off a missing
  provider, and needs `MAIL_FROM` (dev-setup writes it) plus the
  `LUNORA_ADMIN_TOKEN` lunora dev generates. Sends ride the jobs queue, so a
  mail shows up after the queue's ~1s batch window. Nothing delivers locally:
  the only transport is Cloudflare Email Service, which exists only in a deploy.
- **Check the host firewall FIRST when local requests are slow or dropped.**
  On a machine running OpenSnitch, a `workerd` binary without an "allow
  always" rule gets its LOOPBACK connects held or denied. That is every call a
  worker makes to another local worker or to itself: the gateway, the
  scheduler/queue self-dispatch, `/chat/chunks`. It shows up as multi-second
  idle waits and bursts of "Network connection lost.", and it looks exactly like
  an app regression. Measured 2026-09-25: 12% of backend requests lost and a
  20s self-dispatch p50 while the other side logged 13ms and every process was
  idle. After approving the binary: 1.2% and 0.7s. Every wrangler/workerd bump
  ships a new binary path that needs its own rule. `/var/log/opensnitchd.log`
  shows deny rules being added, and `/etc/opensnitchd/rules` should hold an
  allow-always file for the current `workerd-linux-64@<version>`.
- **`wrangler dev` dies with `Network connection lost.`** — miniflare's loopback
  raises it and wrangler escalates it to a fatal process exit, taking the backend
  with it. The app then 500s on SSR purely because the backend is gone, so
  **check `curl localhost:8788/api/health` (or `ss -lntH | grep 8788`) before
  reading any application code.** Two triggers, both ours to avoid:

    1. **An unconsumed response body on a failed outbound fetch.** A Worker must
       consume or cancel every body it opens; a `!response.ok` early-return that
       touches neither is the shape to grep for. Adding
       `await response.body?.cancel()` took 43 forced 403s from 4 fatal exits to 0.
       Every such branch in `backend/lunora` and `llm-gateway` now cancels —
       including the quiet ones: an `if (response.ok)` fall-through, and
       fire-and-forget POSTs whose reply nobody reads. **In the backend, do not
       hand-write that branch when it just throws:** `assertOk(response, "X API
error")` (any transport, including the SSRF-guarded tool
       `fetchWithTimeout`) or `fetchOk(url, { errorPrefix })` from
       `lib/fetch-timeout.ts` cancel the body and throw `HttpError` with the same
       `"<prefix>: <status> <statusText>"` message (`includeBody` keeps a
       truncated body on `.body` instead). Hand-written branches remain only
       where a failure returns a fallback rather than throwing.
    2. **Concurrency on the `__root__` shard** (see "Sharding and concurrency" in `backend/AGENTS.md`). Deterministic repro:

        ```bash
        for i in $(seq 1 10); do curl -s -o /dev/null -X POST localhost:8788/_lunora/rpc \
          -H 'content-type: application/json' \
          -d '{"functionPath":"changelog_functions:getChangelogs","args":{}}' & done; wait
        curl -s -o /dev/null -w '%{http_code}\n' localhost:8788/api/health   # 000
        ```

    Wrangler escalating a recoverable blip to process exit is still an upstream
    defect, **fixed upstream in wrangler 4.129.1**: from there "Error inside
    ProxyWorker" fails only the affected request and the dev server continues.
    The catalog is on wrangler
    4.151.2 + `@cloudflare/vite-plugin` 1.64.0 (workerd 1.20261019.1) (they move together — each
    plugin release peer-requires its wrangler). **Every such bump ships a new
    workerd binary**: on a machine with a per-app firewall (OpenSnitch) an
    unapproved workerd has every `connect()` time out — even to loopback — and
    the whole stack is down until the binary is allowed. The rule is keyed on
    the binary's FULL PATH, so a git worktree's `node_modules/.pnpm/...workerd`
    needs its own rule even when the main checkout's is allowed; the symptom is
    `Ready on http://localhost:8788` in `dev.log` while even `/_lunora/status`
    hangs. Verified after the
    4.141 bump: the 10-concurrent repro above with 300ms client aborts ×3, and 10
    browser contexts closed mid-first-paint, killed the backend 0 times (the
    same close killed 4.124 2 times in 6).
    The failure is INTERMITTENT, so a clean run proves nothing — judge over
    several. When `pnpm test:e2e` shows a run of `TypeError: fetch failed`,
    check whether the backend is still up before debugging them as test defects.
    **The mechanism, reproduced:** a client that ABANDONS a request
    the backend has already accepted — a timeout, a closed tab, a navigation —
    leaves a reply to be written to a closed socket, and that write is the
    "Network connection lost." (closing a context mid-first-paint took the
    backend down 2 times in 6). So anything that aborts requests to 8788 is a
    trigger, and three were ours, now removed: `lunora dev`'s readiness probe
    (1s timeout, every 250ms) against a `/_lunora/status` that waited behind
    `ensureGlobalTables` — now answered first thing in `src/server.ts`, which
    also ended the restart-into-crash-loop; the gateway's `/chat/chunks` poll
    carrying the BROWSER's abort signal (`client-stream.ts`); and bearer
    verification fetching the Worker's OWN `/api/auth/jwks` over loopback with
    jose's 5s timeout — now read in-process. Probe with LONG timeouts; the e2e
    fixtures wait for in-flight backend requests before navigating or closing a
    page (`trackBackendRequests` in `apps/web/e2e/chat-helpers.ts`). On 4.124
    those removals alone did not move the rate (~3 crashes per 100 non-health
    requests, several agents browsing): any browser navigating away from a slow
    first paint is the same trigger — only the wrangler fix removed it.

- **Port 8788 belongs to the backend** — and to the services it binds, which
  run INSIDE its `lunora dev` session with no port of their own. The standalone
  ports — 8787 (llm-gateway, the browser's public gateway, started by `pnpm
dev`), 8789 (browser-renderer), 8790 (embeddings), 8791 (nsfw-checker), 8792
  (document-parser) — matter only when a service runs ALONE (`pnpm
dev:<service>`, spec extraction). The gap at 8788 is deliberate, because
  `backend/.dev.vars` pins `PUBLIC_ORIGIN=http://localhost:8788` (written by
  `scripts/dev-setup.js`; it cannot live in `wrangler.jsonc`, where
  `lunora build` blocks on any loopback address) and
  `backend/project.json` passes `--worker-port 8788`. **A new service takes the
  next free port after 8792 and must never take 8788.** The tell that something
  else grabbed it is a 404 on `/_lunora/status` in that service's log — the
  Lunora supervisor probing 8788 and being answered by the wrong worker.
- **There is a SECOND port map — the wrangler inspectors.** Each service pins one
  in its `package.json` dev script for standalone runs: 9230 (llm-gateway),
  9231 (document-parser), 9232 (browser-renderer), 9233 (embeddings), 9234
  (nsfw-checker); the backend session (with its in-session services) pins
  **9235** with `lunora dev --inspector-port 9235`, in `project.json`'s dev
  target and `package.json`'s `dev` script.
  Any new way of starting it must pass the flag too. That pin matters because
  without it the backend
  takes wrangler's default 9229 and, finding it busy, walks UPWARD into the
  services' range (the standalone gateway holds 9230 in every `pnpm dev`). Two things make this expensive: the error names a port in no
  service map, and _which_ worker dies is non-deterministic. If a worker reports
  `Address already in use` on a 92xx port, run `ss -lntp | grep 92` before
  reading any config — a leftover stack produces the identical error.
- **Every `dev` target needs an explicit `"command"` in its `project.json`**
  (vis 4.0.1). Without a TTY (an agent, CI, a pipe), `vis run dev` runs
  persistent tasks AFTER the graph from each target's `command` only — a target
  that falls through to the `package.json` script is dropped without a word.
  That run also prints `N tasks skipped (dependency failed or --bail)` for
  tasks it is about to start, and discards their output (and a failing one
  kills the others). So in a non-TTY shell `pnpm dev:chat` LOOKS like it
  started nothing even when it did: check `ss -lntH` for the ports, not vis's
  summary, and read logs from the TUI (`script -qec "pnpm dev:chat"`) or from
  per-project `pnpm --filter <name> dev`. The TUI path resolves the script
  itself, which is why this hides at a terminal.
- **Tearing the stack down takes two steps.** The backend is a **managed daemon**
  that is re-parented to init, so killing the `pnpm dev` root does not cover it:
  `cd backend && ./node_modules/.bin/lunora dev stop`, plus `kill` for the rest.
  **`npx lunora` does not work** — there is no `lunora` package on npm (the CLI
  ships as `@lunora/cli`) and the binary is not hoisted to the root
  `node_modules/.bin`. Orphaned workerd processes leak across days (one held
  775 MB two days on); they bind random high ports, so they cost memory rather
  than collisions.
- **The backend logs to `backend/.lunora/dev.log`, not the shell.** Read it with
  `cd backend && ./node_modules/.bin/lunora dev logs`. Editing
  `backend/wrangler.jsonc` does NOT hot-reload (source files do), so an env var
  added there for a probe silently keeps its old value.
- **Renaming or deleting an exported procedure kills a running backend.** The
  source save hot-reloads before codegen rewrites `_generated/functions.ts`,
  which still imports the old name: `Cannot read properties of undefined
(reading 'args')` at startup, and wrangler exits for good. Add the new export
  first, run codegen, then remove the old one — or restart the backend after.
- **`wrangler dev` needs `--local` for the gateway.** From wrangler 4.122 the
  Workers AI binding is proxied to the real network by default, so plain
  `wrangler dev` opens a remote proxy session and dies demanding a
  `CLOUDFLARE_API_TOKEN` in any non-interactive shell. `services/llm-gateway`'s
  `dev` script passes `--local`.
- **`scripts/dev-setup.js` is the only thing that writes `apps/web/.env`, and it
  must cover every REQUIRED var in `apps/web/src/lib/env.ts`.**
  `VITE_LUNORA_URL`, `VITE_SITE_URL` and `VITE_LLM_GATEWAY_URL` are bare
  `z.url()` — not optional — so a missing one is a hard boot failure, not a
  degraded mode. `VITE_LUNORA_URL` is force-_aligned_ rather than defaulted,
  because a stale value is worse than a missing one (see the JWT note in `backend/lunora/auth/AGENTS.md`).
  **If you add a required `VITE_` var to `env.ts`, add it to step 5 of that
  script in the same commit.**
- **A dependency change means clearing `apps/web/node_modules/.vite`.** Vite's
  optimiser otherwise wedges on "bundling dependencies..." indefinitely — port
  open, never serving. Cold start after clearing is ~16s.
- **Never set `server.warmup.clientFiles`.** It deadlocks the client dep
  optimizer and reproduces on a clean cache every time: a warmup transform parks
  on the optimizer, which only commits once the static-import crawl goes idle,
  which cannot happen while that transform is parked. **ONE entry is enough**;
  `ssrFiles` is safe. Removing warmup also made the client scan 13× faster and
  the bundle 2.3× faster, so it cost what it claimed to save. Telling it apart
  from the stale-cache wedge: `.vite/` holds `deps_temp_*` with **no
  `_metadata.json`** and no `deps/`, and
  `curl localhost:5173/node_modules/.vite/deps/react.js` hangs rather than 404s.
  **SSR is unaffected, so the failure is invisible server-side** — `/` returns
  200 with complete markup while the browser is dead. Never take SSR markup, or a
  200 from `curl /`, as evidence that the app hydrates.
- **`pnpm lint:types` can fail spuriously right after a dependency change** —
  `@neore/ai` rebuilds `dist/` while consumers typecheck against it
  (`TS6053: File 'packages/ai/dist/*.d.ts' not found`). Re-run once the build
  lands before believing it.
