# APP MODULE KNOWLEDGE BASE

The rules for working in `apps/web/src`. The detail, reasoning and code examples are in
[the reference](../../../docs/agents/web-src.md); read it for any pattern you have not used here before.

## OVERVIEW

- Main React app: feature-based architecture with TanStack Router integration.

## STRUCTURE

- `components/` shared components; `features/<domain>/` one folder per domain; `lib/lunora/crpc.tsx` the cRPC shim
  (query client, live queries, shard routing live in `packages/client-runtime/src`); `providers/`, `routes/`
  (file-based), `hooks/`; `router.tsx` builds `LunoraClient` + `QueryClient` into the router context.

## WHERE TO LOOK

- Entry: `router.tsx`, `start.ts`. Auth: `features/auth/`. Chat UI: `features/chat/`. cRPC: `lib/lunora/`,
  `packages/client-runtime/src/`. Trigger settings: `features/settings/components/chat/trigger-settings.tsx`.
  Auto-continue UI: `packages/chat-ui/src/chat/`.

## cRPC INTEGRATION (a shim over `@lunora/react`)

- `crpc` is our Proxy in `lib/lunora/crpc.tsx`. Write the nested path `crpc.chat.functions.getThread` (same as
  `api.chat.functions.getThread`); `NEVER_LIVE` lists flat dispatch keys (`chat_functions:getThread`).
- New code may call `lunoraQueryOptions` / `useMutation` from `@lunora/react` directly.
- A shared thread/page lives on its OWNER's shard; `crpc`, live queries, `useUIMessages` and the delta-stream hook
  attach `{ shardKey }` from `packages/client-runtime/src/shard-routing.ts`. A new hook calling the Lunora client
  directly must spread `shardOptionsFor(args)`.
- The registry is filled by `useThreadShard` / `usePageShard` and invite-accept results. Anonymous share pages read
  through ACTIONS (`createLunoraActionQueryOptions`); someone else's public thread redirects to `/thread/$token`.
- `createQueryClient()` takes no argument and nothing calls `connect()`; both clients go in the router context, not
  module scope. `VITE_LUNORA_URL` is the single Worker origin (no `*_SITE_URL`).
- `CRPCProvider` is `LunoraProvider` re-exported; the bearer goes in via `lunoraClient.setAuthToken(token)`.
- Queries: `useQuery(crpc.<path>.queryOptions(args))`; mutations: `useMutation(crpc.<path>.mutationOptions(opts))`.
- Skip with `skipToken` (or `enabled`), never `"skip"` (it causes "No queryFn" errors).
- Pagination: cursor via `paginationOpts` and `continueCursor`. Optimistic/infinite: plain TanStack Query with keys
  from `crpc.<path>.queryKey(args)`; the shim has no `infiniteQueryOptions` and no `meta` object.
- Queries are live; opt out with `{ live: false }` (per-keystroke, heavy, or already live elsewhere).
- Actions: `useAction(api.<path>)` from `@/lib/lunora/crpc`, never via cRPC query options; as a mutation,
  `useLunoraActionOptions(ref)`. Take refs from `api`, never `internal` (this app never imports `internal`).
- `useUIMessages` (`@/lib/agent`) is not cRPC: there `"skip"` is correct.
- Route loaders use `createLunoraQueryOptions(context.lunoraClient, api.<path>, args)` with
  `ensureQueryData` / `prefetchQuery` (`useCRPC` is a hook).
- Auth: `__root.tsx` `beforeLoad` sets the token; `AuthRecovery` refetches on login. `<Unauthenticated>` means "no
  token", not "no session": never widen that gate (see `features/auth/AGENTS.md`).
- Retry policy lives in `packages/client-runtime/src/query-client.ts` (`isAuthError` 2 retries; rate-limited and
  forbidden never), not in provider props.
- Types: `ArgsOf` / `ReturnOf` from `@lunora/react` on `typeof api.x` (`inferApiInputs`/`inferApiOutputs` are gone).
- Lunora upstream constraints (do not re-file): `docs/agents/lunora-upstream.md`. Skills: `.agents/skills/lunora*`,
  start with `lunora`. Generated API: `@neore/backend/api`.

## TANSTACK START PATTERNS

- Validate every `createServerFn` input with a Zod schema via `.validator(...)`, never a casting `inputValidator`
  (`functions/update-locale.ts`).
- Target file suffixes `.server.ts` (server-only), `.functions.ts` (RPC), `.client.ts`; `lib/auth/` still uses bare
  names (`lib/auth/README.md`). `import type` from `.server.ts` is safe.
- Guard layout routes with `requireSession(context, location)` (`@/lib/auth/route-guard`) in `beforeLoad`, not by
  checking `context.isAuthenticated`; loaders return early while `!context.isAuthenticated`. There is no
  `_authenticated/` layout; `(chat)/route.tsx` uses `<Authenticated>`.
- Throw/handle the error classes from `lib/errors/index.ts` (`ServerError`, `ValidationError`, …), switching on `code`.
- Access browser APIs only after hydration: track `isHydrated` (`features/auth/hooks/use-last-signin-method.ts`).

## CONVENTIONS

- Organize by domain; file-based routing in `routes/`; SSR on Cloudflare Workers; strict TypeScript.
- Query cache is authoritative (`defaultPreloadStaleTime: 0`); prefetch with `ensureQueryData` in loaders.
- Zod in server functions; suffix convention above; route protection in `beforeLoad` of layouts; errors from
  `lib/errors/index.ts`; `isHydrated` before browser APIs.
- Prefer composition over inheritance; cRPC for queries/mutations, `useAction` for actions; pass the QueryClient via
  router context, not globals.

## ANTI-PATTERNS

- Don't bypass authentication hooks, manipulate the DOM directly, skip TypeScript types, or mix feature concerns.
- No second data-client library; use cRPC, or `createLunoraQueryOptions` in static contexts. Generics `assert`,
  `BetterOmit`, `Expand`, `ErrorMessage` are in `src/lib/agent/type-utilities.ts`.
- Don't attach a chat file with `attachmentAdapter.add()` alone: call `upload` (`add` + `send`) so the id lands in
  `metadata.fileId`. Size limits: `attachmentSizeLimit` (documents from `@neore/backend/document-limits`).
- Don't use the flattened `api.chat_functions.getThread` form; references and `crpc` nest by folder and file.
- `"skip"` only for `useUIMessages` and the other `@/lib/agent` paginated hooks; `skipToken` everywhere else.
- Always brace `if` bodies, even single statements (`if (condition) { return; }`).
