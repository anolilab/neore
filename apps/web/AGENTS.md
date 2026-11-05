# APP PACKAGE KNOWLEDGE BASE

**Generated:** 2026-02-17
**Updated:** 2026-10-10 (script locations and type-helper path re-checked)
**Parent:** ../../AGENTS.md

## OVERVIEW

Main React application using TanStack Start + Cloudflare Workers.
For detailed docs (cRPC patterns, TanStack Start patterns, feature structure), see `src/AGENTS.md`.

## COMMANDS

```bash
# From the repo root (vis tasks; apps/web's package.json has no dev:* scripts)
pnpm dev:backend          # Start the Lunora backend (run alongside dev:app)
pnpm dev:app              # Start main app
pnpm build:chat           # Build chat application
pnpm lint:types           # TypeScript check (NOT pnpm typecheck); inside apps/web it is `tsc --noEmit`
```

## KEY ENTRY POINTS

| File                                   | Purpose                          |
| -------------------------------------- | -------------------------------- |
| `src/routes/__root.tsx`                | App root with provider hierarchy |
| `src/lib/lunora/crpc.tsx`              | cRPC context (useCRPC hook)      |
| `src/routes/(chat)/chat/$threadId.tsx` | Thread route entry               |
| `src/features/chat/`                   | All chat UI features             |

## CONVENTIONS

**Backend data comes only through `@/lib/lunora/crpc` (over `@lunora/react`).**
The env var is **`VITE_LUNORA_URL`** (see `src/lib/env.ts` and `src/router.tsx`),
and there is no separate `*_SITE_URL`: one Lunora Worker serves both
`/_lunora/rpc` and `/api/auth/*`. The browser extension uses the same name.

- **cRPC for all backend data**: `useCRPC()` + TanStack Query
- **Actions**: `useAction` from `@/lib/lunora/crpc` (not cRPC query options)
- **skipToken not "skip"**: Use `skipToken` from `@tanstack/react-query` for conditional queries
- **Feature folders**: `src/features/<domain>/` for all domain code
- **TypeScript strict**: Explicit types on all callback params

## ANTI-PATTERNS

- Don't import a second data-client library. The generic helpers `assert`,
  `BetterOmit`, `Expand` and `ErrorMessage` live in
  `src/lib/agent/type-utilities.ts`.
- Don't use `"skip"` string with cRPC queryOptions — use `skipToken` from `@tanstack/react-query`
- Don't bypass authentication hooks

## INVARIANTS (moved from the root AGENTS.md)

- **Spreadsheets / design canvas** — `"sheet"` artifacts store CSV in
  `documents.content` (Univer editor, code-split XLSX convert). `"design"`
  artifacts store Fabric.js JSON in `contentJson` and a PNG data URL preview in
  `content`. Both editors are code-split; keep them that way.

## ACCESSIBILITY

**Target: WCAG 2.1 AA.** `eslint-plugin-jsx-a11y` is active via
`@anolilab/eslint-config` — do not disable its rules.

- **Base UI foundation**: interactive primitives come from `@base-ui/react`,
  which handles ARIA roles, keyboard nav and focus trapping. Prefer them over
  custom implementations.
- **Semantic HTML first** — `<nav>`, `<main>`, `<button>`, `<a>` before `role=`.
- **Every control needs an accessible name.** Icon-only buttons always need
  `aria-label` or `sr-only` text.
- `<label>` must wrap its control or use `htmlFor`. For composite widgets
  (color pickers, file uploads) use `role="group"` + `aria-labelledby`.
- **Live regions**: streaming responses, loading states and toasts need
  `aria-live="polite"` or `role="status"`; urgent alerts `assertive`.
- **Hidden content** hidden by CSS also needs `aria-hidden="true"`, or screen
  readers navigate into it.
- Icons beside text get `aria-hidden="true"`; purely decorative images get
  `role="presentation"`.
- `packages/ui/src/global.css` has a global `prefers-reduced-motion` rule;
  Motion components must respect it too.

| Pattern               | Example                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Icon-only button      | `<Button aria-label="Close"><XIcon aria-hidden="true" /></Button>`                         |
| Streaming status      | `<span role="status" aria-live="polite">{statusText}</span>`                               |
| Composite field label | `<div role="group" aria-labelledby="label-id"><label id="label-id">Color</label>...</div>` |
| Hidden branch         | `<div aria-hidden={!isActive} className={isActive ? "block" : "hidden"}>`                  |

## Frontend

- **`crpc.X.queryOptions()` is LIVE by default**.
  `lib/lunora/live-queries.ts` watches the TanStack cache: an active Lunora key
  opens a WebSocket subscription whose pushes `setQueryData`, and it
  unsubscribes 10s after its last observer leaves. The queryFn answers from the
  subscription, so a live query costs one execution on first paint rather than
  RPC + seed. SSR still fetches once, and the browser subscribes after hydrate.
  `skipToken`/`enabled: false` never subscribe. Opt out per call with
  `queryOptions(args, { live: false })`, or for everyone with `NEVER_LIVE` in
  `crpc.tsx`. Opt out for per-keystroke searches, heavy aggregates, and data a
  Lunora hook already subscribes to (`useUIMessages`). Five things to know:
    - **The subscription's args come from `meta.lunoraArgs`, never the key.**
      Since `@lunora/react@alpha.166` a query key's args slot is the
      wire-encoded STRING, not the object; subscribing with it sent every
      procedure a string, so each required arg read `undefined` (streams never
      settled, first paint fell back to RPC). `crpc`'s live `queryOptions` sets
      the meta; `live-queries.ts#argsOf` reads it (an observer's, after a
      hydrate). A hand-built live key needs the same meta.
    - **Every live query re-runs on its shard** (the caller's, or a shared
      object's owner's — the client opens one socket per shard) whenever a
      write touches a table (index range) it read. Measured `/chat` first paint: 7
      live subscriptions (11 before `NEVER_LIVE`), `/tasks` 5. The cap is 32 per
      socket (`TOO_MANY_SUBSCRIPTIONS`), and a query that hits it quietly falls
      back to one-shot.
    - **Seeds are throttled to 3 in flight** (`MAX_CONCURRENT_SEEDS`). Eleven at
      once reproduced local dev's fatal `Network connection lost.` in 2 of 7
      runs; three at a time, 0 of 4, and no slower (~4s cold, 0.2–0.5s per seed
      warm). Upstream #796 (`@lunora/client@alpha.126`) now paces RECONNECT and
      tab-leader resubscribes to 3 in flight, but not these first-paint seeds,
      so this throttle is still needed.
    - **The socket authenticates with a single-use ticket, not the JWT** (see
      the Auth notes in `backend/lunora/auth/AGENTS.md` and `lib/lunora/ws-ticket.ts`). `setAuthToken` never
      re-authenticates an open socket, so the manager bounces it when the
      token's SUBJECT changes, not on a same-user refresh.
    - **Manual `invalidateQueries` after a mutation is now a fallback.** While a
      subscription is open it is answered from it without an RPC. It is
      harmless, so it was left in place.
- **E2E against the mock model.** `MOCK_LLM=1` in `services/llm-gateway/.dev.vars`
  swaps every model for `providers/mock-model.ts` (refused when NODE_ENV or
  ENVIRONMENT is production): replies are `Mock reply: <prompt>`,
  `[[reasoning]]` adds reasoning, `[[tool:<name> <json>]]` calls a tool once, and
  schema/"Respond with ONLY a JSON object" calls get minimal valid JSON with
  booleans `true`. On a machine with a per-app firewall (OpenSnitch) a freshly
  downloaded Playwright Chromium has its SYNs dropped even to loopback — every
  `goto` times out while curl works — until it is allowed;
  `E2E_BROWSER_CHANNEL=chrome` runs the installed Chrome meanwhile.

- **A form can be visible before it is interactive.** The auth pages are
  server-rendered, so inputs paint — and Playwright sees them — before React has
  attached the submit handler. **`toBeEnabled()` does not close this window**; it
  is a rendering check and the SSR'd button is already enabled. Use
  `awaitFormHydrated()` from `e2e/helpers.ts`, which waits for `form[novalidate]`
  — the forms set `noValidate={isHydrated}`, so that attribute cannot appear in
  SSR markup and is therefore a signal the CLIENT owns. A click inside the window
  does nothing at all: no request, and the browser falls back to a native GET
  that shows up as a navigation to `/auth/sign-up?`. It reads exactly like a form
  that refuses to submit — and an unreachable backend produces the same symptom
  for a different reason, so check both.
- **`react-doctor` reports React Compiler bail-outs that do not happen in the
  build.** It runs the compiler over RAW source without this app's babel plugins.
  The Lingui macro is one of those, so every `` t`...${x}...` `` reads as an
  unlowerable tagged template — 186 of 243 such findings, ~37% of its error
  count. **Do not "fix" these**, and in particular do not split the babel passes
  in `vite.config.ts` to chase them: the passes are already correct, and
  rewriting `t` templates by hand changes extracted message IDs and breaks the
  translation catalogs.
- **A `todo` finding means the compiler bailed out**, so that component's manual
  `useMemo`/`useCallback` is the ONLY memoization it has. Removing it because
  `react-compiler-no-manual-memoization` also fires is a performance regression,
  not a cleanup. Fix the bail-out first or leave both.
- **Measured 2026-09-25: the compiler skips every function with a destructuring
  default** (`({ size = "default" })`) — 454 of 1688 in `apps/web` +
  `packages/ui` + `packages/chat-ui`, including `MessageItem`, `MessageList`
  and chat-ui's `MessageContent`. It calls `path.isLVal()`, a method of
  `@babel/traverse@7`, whose `@babel/types` the global `"@babel/types": 8.0.4`
  override replaces (Babel 8 dropped `AssignmentPattern` from `LVal`); the
  `babel-plugin-react-compiler>@babel/types` override does not reach it. Check a
  component in the served dev module (`curl localhost:5173/src/…tsx`): compiled
  code starts with `const $ = _c(n)`. The other common bail-outs are cheap to
  avoid — no `throw`, `finally`, or `?:`/`&&`/`??`/`?.` inside a `try`/`catch`
  in a component (move it into a module-level helper), no ref read during render.
- **Chat rows are memoized on message IDENTITY.** `useUIMessages` structurally
  shares unchanged messages across live pushes (`lib/agent/share-unchanged-messages.ts`),
  and the chat action callbacks read `messagesRef`, not `messages` — a callback
  closing over `messages` changes the actions context on every push, which
  re-renders every row of the thread (measured: 400 content renders for a
  one-message change in a 200-message thread; now 1). The streaming reply
  batches chunks per animation frame (`createFrameBatcher`).

- **KaTeX and Mermaid must stay off the startup path.** Reach
  `@streamdown/math`/`@streamdown/mermaid` only through
  `@neore/ui/hooks/use-streamdown-plugins` — one static import anywhere makes
  them eager again. `reactjs-tiptap-editor` also carries KaTeX, so the tiptap
  editors are `lazy()` at their chat-route call sites. And never put a lazily
  loaded package in a `codeSplitting` group in `apps/web/vite.config.ts`: a group
  is one chunk, it swallows its members' dependencies, and one eager importer of
  any of them loads all of it (that is how `vendor-diagrams` put Mermaid back on
  the chat page). Measured win: chat route −1.9 MB raw / −534 KB gzip, extension
  panel −870 KB / −226 KB.
