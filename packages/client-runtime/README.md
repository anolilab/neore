# @neore/client-runtime

The framework-free client runtime shared by the web app and the native apps:
live-query subscriptions, the single-use socket ticket, shard routing, token
refresh, the session read with its retry policy, locked-chat unlock proofs and
the TanStack query client's retry policy. Private; consumed as TypeScript
source (`src/index.ts`), no build step.

Nothing here imports the router, `react-dom` or the generated `api`. The
pieces that need the browser or the app's own wiring (the shared session read,
the better-auth client, `crpc`) stay in `apps/web/src/lib`. Depends on
`@lunora/client`, `@lunora/react` and `@tanstack/react-query`; `react` is a
peer.

Used by `apps/web` (`crpc`, the router, chat hooks) and `apps/mobile`
(`tokenRefreshDelayMs`).

## Exports

Everything is re-exported from the package root, `@neore/client-runtime`:

| Module               | What it does                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-queries`       | `connectLiveQueries`, `LiveQueryManager`: a WebSocket subscription per active query, pushed into the TanStack cache; `LINGER_MS`, `MAX_CONCURRENT_SEEDS`        |
| `live-query-entry`   | `Entry`: one subscription's state, tracked per query hash                                                                                                       |
| `ws-ticket`          | `createWsTicketMinter`: POSTs the bearer to `/_lunora/ws-ticket` and returns the single-use ticket the socket authenticates with                                |
| `shard-routing`      | A shared thread or page lives on its owner's shard: `registerThreadShard`, `notePageShard`, `shardKeyForArgs`, `shardOptionsFor`, `resetShardRegistry`          |
| `token-refresh`      | `tokenRefreshDelayMs`: when to renew the RPC bearer                                                                                                             |
| `hydrate-auth-token` | `seedHydratedAuthToken`: hands the browser client the token fetched during SSR                                                                                  |
| `session-read`       | Retry policy for the session read: `readWithRetry`, `BROWSER_SESSION_READ_POLICY`, `SessionReadFailedError`, `isSessionReadRequest`, `isSessionChangingRequest` |
| `sign-in-lock`       | Tracks in-flight credential requests so a guest is not minted over an account being signed in                                                                   |
| `unlock-proofs`      | In-memory passcode proofs of locked chats: `rememberUnlockProof`, `currentUnlockProof`, `withUnlockProof`, `useUnlockProof`                                     |
| `lunora-helpers`     | `runLunoraAction`, `useAction`, `useLunoraAuth`, `createLunoraQueryOptions`, `createLunoraActionQueryOptions`                                                   |
| `query-client`       | `createQueryClient`, `hydrationConfig`: deterministic client errors are never retried, auth errors get two attempts                                             |
| `auth-errors`        | `isAuthError`                                                                                                                                                   |
| `ids`                | `LUNORA_ID_SOURCE`, `isLunoraId`: Lunora row ids are lowercase UUIDs                                                                                            |

```ts
// apps/web/src/router.tsx
import { connectLiveQueries, createQueryClient, createWsTicketMinter } from "@neore/client-runtime";

const queryClient = createQueryClient();

connectLiveQueries(lunora, queryClient, createWsTicketMinter(env.VITE_LUNORA_URL), { dev: import.meta.env.DEV });
```

## Things to know

- **The socket never carries the JWT.** Workers observability logs request
  URLs, so the manager mints a single-use 30 s ticket before each (re)connect.
  `setAuthToken` does not re-authenticate an open socket; the manager bounces
  it when the token's subject changes (`tokenSubject`).
- **Live queries seed at most 3 at a time** (`MAX_CONCURRENT_SEEDS`). Raising it
  reproduced a fatal dev-backend `Network connection lost.`; see root
  `CLAUDE.md`, "Frontend".
- **A call about someone else's thread or page must name the owner's shard.**
  The registry here is filled by the app (`useThreadShard`, `usePageShard`,
  invite-accept results); any hook that calls the Lunora client directly must
  spread `shardOptionsFor(args)` (`apps/web/src/AGENTS.md`,
  `plans/per-user-sharding.md`).
- **A failed session read is "unknown", never "signed out".** Use the retry
  policy in `session-read`; a 429 must not read as no session.
- **Unlock proofs live in memory only**, never in storage or a cookie, so a
  reload re-locks every chat.

## Development

```bash
pnpm --filter @neore/client-runtime run test         # vitest run (node environment)
pnpm --filter @neore/client-runtime run lint:types   # tsc --noEmit
```

With `vis`, use the `package.json` name: `--projects=@neore/client-runtime`.
