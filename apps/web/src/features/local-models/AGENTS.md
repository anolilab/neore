# LOCAL MODELS — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Local models (Ollama / LM Studio)** — custom endpoint `type: "local-browser"`:
  the BROWSER calls the loopback server directly (`apps/web/src/features/local-models`),
  then persists text only via `chat.local_models.saveLocalTurn` (no tools, no
  usage, `provider: "local-browser"`, not billed). The server never fetches it and
  `resolveRunModel` refuses it (`local-endpoint`). Regenerate and edit branch to
  the browser in `chat-context.tsx` when the current model is local, and
  `saveLocalTurn({ branch })` saves them as siblings — a regenerate needs
  `failPendingSteps: true` on the reply, or it chains UNDER the old reply
  instead of beside it. **Three lists must agree:** `LOCAL_ENDPOINT_HOSTS`
  (`@neore/ai/models`), `LOCAL_MODEL_CONNECT_SOURCES` in the web CSP, and the
  loopback-only validator — widen one alone and saves succeed that the browser
  then blocks, or the CSP opens the LAN. Safari cannot use it (WebKit upgrades
  `http://localhost` from https pages); Chromium and Firefox exempt loopback.
  The Electron desktop shell is Chromium, so the Safari mixed-content check
  (`isSafariUserAgent`) is skipped inside it (`isNativeShell()`).
