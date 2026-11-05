# APP PACKAGE KNOWLEDGE BASE

The rules for working in `apps/web`. The detail, reasoning and code examples are in
[the reference](../../docs/agents/web.md); read it before changing anything a rule here names.

## OVERVIEW

- Main React app: TanStack Start + Cloudflare Workers. cRPC, TanStack Start and feature-structure patterns: `src/AGENTS.md`.

## COMMANDS

```bash
# From the repo root (vis tasks; apps/web's package.json has no dev:* scripts)
pnpm dev:backend          # Start the Lunora backend (run alongside dev:app)
pnpm dev:app              # Start main app
pnpm build:chat           # Build chat application
pnpm lint:types           # TypeScript check (NOT pnpm typecheck); inside apps/web it is `tsc --noEmit`
```

## KEY ENTRY POINTS

- `src/routes/__root.tsx` (provider hierarchy), `src/lib/lunora/crpc.tsx` (`useCRPC`),
  `src/routes/(chat)/chat/$threadId.tsx` (thread route), `src/features/chat/` (chat UI).

## CONVENTIONS

- Backend data comes only through `@/lib/lunora/crpc`: `useCRPC()` + TanStack Query. Env var is `VITE_LUNORA_URL`
  (one Worker serves `/_lunora/rpc` and `/api/auth/*`; no `*_SITE_URL`; the extension uses the same name).
- Actions: `useAction` from `@/lib/lunora/crpc`, not cRPC query options.
- Conditional queries: `skipToken` from `@tanstack/react-query`, never `"skip"`.
- Domain code in `src/features/<domain>/`; strict TypeScript with explicit types on all callback params.
- **Native shell**: call `notifyNative` (`src/lib/native/bridge.ts`, a no-op outside the desktop shell) from any
  long-running flow; shell details in `apps/desktop/AGENTS.md`.

## ANTI-PATTERNS

- No second data-client library. Generic helpers `assert`, `BetterOmit`, `Expand`, `ErrorMessage` are in
  `src/lib/agent/type-utilities.ts`.
- No `"skip"` string with cRPC `queryOptions`; no bypassing the authentication hooks.

## INVARIANTS (moved from the root AGENTS.md)

- `"sheet"` artifacts: CSV in `documents.content` (Univer). `"design"`: Fabric.js JSON in `contentJson`, PNG data
  URL preview in `content`. Both editors (and XLSX convert) stay code-split.

## ACCESSIBILITY

- Target WCAG 2.1 AA; never disable `eslint-plugin-jsx-a11y` rules. Prefer `@base-ui/react` primitives over custom ones.
- Semantic HTML (`<nav>`, `<main>`, `<button>`, `<a>`) before `role=`.
- Every control has an accessible name; icon-only buttons need `aria-label` or `sr-only` text.
- `<label>` wraps its control or uses `htmlFor`; composite widgets use `role="group"` + `aria-labelledby`.
- Streaming, loading and toasts: `aria-live="polite"` or `role="status"`; urgent alerts `assertive`.
- CSS-hidden content also gets `aria-hidden="true"`; icons beside text `aria-hidden="true"`; decorative images
  `role="presentation"`.
- Motion components respect `prefers-reduced-motion` (global rule in `packages/ui/src/global.css`). Examples: reference.

## Frontend

- `crpc.X.queryOptions()` is LIVE by default (`packages/client-runtime/src/live-queries.ts`). Opt out with
  `queryOptions(args, { live: false })` or `NEVER_LIVE` in `crpc.tsx` for per-keystroke searches, heavy aggregates
  and data a Lunora hook already subscribes to (`useUIMessages`).
- A hand-built live key must set `meta.lunoraArgs`; subscriptions read args from it, never from the key.
- Keep live subscriptions few: each re-runs on every write to what it read; cap 32 per socket (`TOO_MANY_SUBSCRIPTIONS`
  silently falls back to one-shot). Keep the `MAX_CONCURRENT_SEEDS` = 3 throttle.
- The socket authenticates with a single-use ticket, not the JWT (`packages/client-runtime/src/ws-ticket.ts`); it is
  bounced only on a subject change. Manual `invalidateQueries` after a mutation is a harmless fallback.
- E2E: `MOCK_LLM=1` in `services/llm-gateway/.dev.vars` uses `providers/mock-model.ts` (syntax in the reference).
  Under a per-app firewall allow Playwright's Chromium, or use `E2E_BROWSER_CHANNEL=chrome`.
- Before interacting with an SSR'd form in e2e, call `awaitFormHydrated()` (`e2e/helpers.ts`); `toBeEnabled()` is
  not enough. A dead backend shows the same symptom, so check both.
- Do not "fix" `react-doctor` bail-outs on Lingui `` t`…` `` templates, split the babel passes in `vite.config.ts`, or
  rewrite `t` templates by hand (breaks message IDs).
- On a `todo` (compiler bail-out) finding, keep the manual `useMemo`/`useCallback`; fix the bail-out first or leave both.
- Keep the `"@babel/traverse@7>@babel/types"` override in `pnpm-workspace.yaml`. In components avoid `throw`, `finally`,
  `?:`/`&&`/`??`/`?.` inside `try`/`catch` (use a module-level helper) and ref reads during render.
- **Chat rows are memoized on message IDENTITY**: keep `useUIMessages`' structural sharing
  (`lib/agent/share-unchanged-messages.ts`); chat action callbacks read `messagesRef`, never close over `messages`;
  stream chunks are batched per frame (`createFrameBatcher`).
- KaTeX/Mermaid stay off the startup path: import `@streamdown/math`/`@streamdown/mermaid` only via
  `@neore/ui/hooks/use-streamdown-plugins`; keep the tiptap editors `lazy()` at chat-route call sites; never put a
  lazily loaded package in a `codeSplitting` group in `apps/web/vite.config.ts`.
