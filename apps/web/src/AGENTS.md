# APP MODULE KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (feature list and entry points re-checked); 2026-09-02 (Lunora migration: cRPC section rewritten against `lib/lunora/crpc.tsx`); 2026-03-07 (triggers settings, auto-continue UI)
**Parent:** ./AGENTS.md

## OVERVIEW

Main React application with complex feature-based architecture and TanStack Router integration.

## STRUCTURE

```text
apps/web/src/
├── components/        # Shared React components
├── features/          # Feature-based organization (one folder per domain)
│   ├── auth/          # Authentication system
│   ├── chat/          # Core chat functionality
│   ├── canvas/        # Canvas/artifacts
│   ├── coding-agents/ # Coding agent runs (E2B)
│   ├── pages/         # Pages (own table, not documents)
│   ├── projects/      # Project management
│   ├── prompts/       # Prompt management
│   ├── settings/      # Application settings
│   ├── vault/         # Data vault features
│   ├── workflow/      # Workflows and the gallery
│   ├── layout/        # Layout components
│   └── keyboard/      # Keyboard shortcuts
│   # also: admin, appearance, billing, changelog, devices, evals, home, knowledge,
│   # local-models, marketing, notifications, onboarding, skills, slides, sub-agents, tasks
├── lib/               # Utilities and configuration
│   └── lunora/        # Lunora/cRPC integration
│       ├── crpc.tsx            # cRPC shim over @lunora/react + hooks
│       ├── query-client.ts     # TanStack Query configuration (retry policy)
│       ├── live-queries.ts     # WebSocket subscriptions pushed into the query cache
│       └── shard-routing.ts    # object id -> owner shard registry
├── providers/         # React context providers
├── routes/            # TanStack Router routes (file-based)
├── hooks/             # Global React hooks
└── router.tsx         # Builds LunoraClient + QueryClient into the router context
```

## WHERE TO LOOK

| Task                 | Location                                                   | Notes                                        |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| App entry point      | router.tsx, start.ts                                       | TanStack Router + Start middleware           |
| Authentication       | features/auth/                                             | Better Auth integration, forms, settings     |
| Chat UI              | features/chat/                                             | Thread management, composer, message display |
| Routing              | routes/                                                    | File-based routing with TanStack             |
| Component library    | components/                                                | Reusable UI components                       |
| Global state         | providers/                                                 | React context providers                      |
| **Lunora/cRPC**      | **lib/lunora/**                                            | **cRPC shim, QueryClient, Lunora hooks**     |
| **Trigger settings** | **features/settings/components/chat/trigger-settings.tsx** | **Trigger CRUD page**                        |
| **Auto-continue UI** | **packages/chat-ui/src/chat/**                             | **Composer toggle + status bar**             |

## cRPC INTEGRATION (a shim over `@lunora/react`)

**`crpc` is no longer a library — it is our own Proxy in `lib/lunora/crpc.tsx`.**
The backend is Lunora, but ~250 call sites across 94 files were shaped around
the `crpc.<path>.queryOptions(args)` form. Rewriting every one to
`lunoraQueryOptions(client, api.ns.module.fn, args)` touches almost every feature
directory at once, so the _shape_ stayed and the _implementation_ moved.

**Write the nested form: `crpc.chat.functions.getThread`,** the same path as
`api.chat.functions.getThread` — one segment per folder and file under
`backend/lunora/`. The API nests by folder since `@lunora/codegen@alpha.275`
(earlier builds flattened it to `api.chat_functions`). The dispatch key a
reference carries stays flat (`chat_functions:getThread`), which is what
`NEVER_LIVE` lists. A wrong path throws naming the attempted key rather than
silently resolving to a deep proxy.

New code may also call `lunoraQueryOptions` / `useMutation` from `@lunora/react`
directly. The shim exists so the existing call sites didn't all have to change
in one commit.

### Shards: a shared thread or page lives on its OWNER's shard

The backend routes a call that names no shard to the CALLER's own
(docs/plans/per-user-sharding.md). A call about someone else's thread or page
must name the owner's shard — and no call site does that by hand:
`lib/lunora/shard-routing.ts` keeps `threadId`/`chatId`/`pageId`/`streamId` →
owner, and `crpc` (queries, mutations, actions), the live-query manager,
`useUIMessages` and the delta-stream hook attach `{ shardKey }` for any call
whose args name a registered object. The registry is filled by
`useThreadShard` (the `/chat/$threadId` route renders nothing until it has
settled) / `usePageShard`, and by the invite-accept results; it resets when
the signed-in user changes. A new hook that calls the Lunora client directly
must spread `shardOptionsFor(args)` too. Anonymous share pages
(`/thread/$token`, `/p/$token`, shared workflows) read through ACTIONS
(`createLunoraActionQueryOptions`) that cross to the owner's shard
server-side. For the same reason `/chat/$threadId` of someone ELSE's public
thread (no grant) reads not-found from `getThread` — the viewer's own shard
does not hold it — so the route asks `chat_sharing.getThreadShareToken` and
redirects to `/thread/$token`.

### Key Files

| File                         | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `lib/lunora/crpc.tsx`        | The `crpc` Proxy, `useCRPC`, re-exported provider/hooks, static loader helper |
| `lib/lunora/query-client.ts` | TanStack QueryClient config: retry policy + backend-error logging             |
| `router.tsx`                 | Builds `LunoraClient` + `QueryClient` into the router context                 |
| `routes/__root.tsx`          | Provider hierarchy (`QueryClientProvider` → `CRPCProvider` → auth)            |

### Client Setup

Nothing needs to `connect()` —
`lunoraQueryOptions` supplies its own `queryFn` and `queryKey`, so
`createQueryClient()` takes no argument:

```typescript
// router.tsx
import { LunoraClient } from "@lunora/client";

import { createQueryClient } from "./lib/lunora/query-client";

const lunora = new LunoraClient({ url: env.VITE_LUNORA_URL });
const queryClient = createQueryClient();

// Both go into the router context, not module scope.
const router = createTanstackRouter({
    context: { i18n, lunoraClient: lunora, queryClient },
    // ...
});
```

`VITE_LUNORA_URL` is the single Lunora Worker origin — it serves both
`/_lunora/rpc` and `/api/auth/*`. There is no second `*_SITE_URL` var.

### Provider Hierarchy

```tsx
// routes/__root.tsx — reads both clients off the route context
<QueryClientProvider client={context.queryClient}>
    <CRPCProvider client={context.lunoraClient} queryClient={context.queryClient}>
        <AuthRecovery>
            <AuthQueryProvider>
                <AuthUIProviderTanstack authClient={authClient} /* ... */>{children}</AuthUIProviderTanstack>
            </AuthQueryProvider>
        </AuthRecovery>
    </CRPCProvider>
</QueryClientProvider>
```

`CRPCProvider` is just `LunoraProvider` from `@lunora/react` re-exported under
the old name. Auth is Better Auth's own provider stack; the bearer token is pushed in with
`context.lunoraClient.setAuthToken(token)`.

### Usage Patterns

#### Basic Queries

```tsx
import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

function MyComponent() {
    const crpc = useCRPC();

    // Simple query with required args
    const { data, error, isPending } = useQuery(crpc.chat.functions.getThread.queryOptions({ threadId }));

    // Query with empty args
    const { data: threads } = useQuery(
        crpc.chat.functions.getThreads.queryOptions({
            paginationOpts: { cursor: null, numItems: 100 },
        }),
    );
}
```

#### Conditional Queries (Skipping)

**IMPORTANT:** Use `skipToken` from `@tanstack/react-query` to conditionally skip queries.
Do NOT use the string `"skip"` — that only works with the paginated hooks in `@/lib/agent` (see below), not with cRPC/TanStack Query.

```tsx
import { skipToken, useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

function MyComponent({ threadId }: { threadId?: string }) {
    const crpc = useCRPC();

    // ✅ CORRECT: Use skipToken for conditional queries
    const { data: thread } = useQuery(crpc.chat.functions.getThread.queryOptions(threadId ? { threadId } : skipToken));

    // ✅ CORRECT: Boolean condition
    const { data: pinnedThreads } = useQuery(crpc.chat.functions.getPinnedThreads.queryOptions(isOpen ? {} : skipToken));

    // ❌ WRONG: Do NOT use "skip" string - causes "No queryFn" errors
    // const { data } = useQuery(
    //   crpc.chat.functions.getThread.queryOptions(
    //     threadId ? { threadId } : "skip"  // ❌ WRONG
    //   )
    // );

    // Alternative: Use `enabled` option (less type-safe)
    const { data: thread2 } = useQuery({
        ...crpc.chat.functions.getThread.queryOptions({ threadId: threadId! }),
        enabled: !!threadId,
    });
}
```

#### Mutations

```tsx
import { useMutation } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

function MyComponent() {
    const crpc = useCRPC();

    // Basic mutation
    const { isPending, mutateAsync: createThread } = useMutation(crpc.chat.functions.createThread.mutationOptions());

    // Mutation with callbacks
    const { mutateAsync: updateThread } = useMutation(
        crpc.chat.functions.updateThread.mutationOptions({
            onError: (error) => toast.error(error.message),
            onSuccess: () => toast.success("Updated!"),
        }),
    );

    // Usage
    const handleCreate = async () => {
        const result = await createThread({ title: "New Thread" });
        // result is typed based on the mutation return type
    };

    const handleUpdate = async () => {
        await updateThread({ threadId, title: "Updated Title" });
    };
}
```

#### Paginated Queries (Manual Pagination)

For paginated data, use standard queries with cursor-based pagination:

```tsx
import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

const MyComponent = () => {
    const crpc = useCRPC();
    const [cursor, setCursor] = useState<string | null>(null);

    const { data: threads } = useQuery(
        crpc.chat.functions.getThreads.queryOptions({
            paginationOpts: { cursor, numItems: 20 },
        }),
    );

    const loadMore = () => {
        if (threads?.continueCursor) {
            setCursor(threads.continueCursor);
        }
    };

    return (
        <>
            {threads?.page.map((thread) => (
                <Thread key={thread._id} {...thread} />
            ))}
            {!threads?.isDone && <button onClick={loadMore}>Load More</button>}
        </>
    );
};
```

#### Infinite Queries

For infinite scroll patterns, use `useInfiniteQuery` with `infiniteQueryOptions`:

```tsx
import { useInfiniteQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

const InfiniteThreadList = () => {
    const crpc = useCRPC();

    const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery(
        crpc.chat.functions.getThreads.infiniteQueryOptions(
            { numItems: 20 },
            {
                getNextPageParam: (lastPage) => (lastPage.isDone ? undefined : lastPage.continueCursor),
            },
        ),
    );

    // Flatten pages into single array
    const allThreads = data?.pages.flatMap((page) => page.page) ?? [];

    return (
        <>
            {allThreads.map((thread) => (
                <Thread key={thread._id} {...thread} />
            ))}
            {hasNextPage && (
                <button disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
                    {isFetchingNextPage ? "Loading..." : "Load More"}
                </button>
            )}
        </>
    );
};
```

#### Query with Optimistic Updates

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

function ThreadItem({ thread }: { thread: Thread }) {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const { mutateAsync: togglePin } = useMutation({
        ...crpc.chat.functions.pinThread.mutationOptions(),
        onMutate: async ({ threadId }) => {
            // Cancel outgoing refetches
            await queryClient.cancelQueries({
                queryKey: crpc.chat.functions.getThread.queryKey({ threadId }),
            });

            // Snapshot previous value
            const previous = queryClient.getQueryData(crpc.chat.functions.getThread.queryKey({ threadId }));

            // Optimistically update
            queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId }), (old) => (old ? { ...old, isPinned: !old.isPinned } : old));

            return { previous };
        },
        onError: (err, variables, context) => {
            // Rollback on error
            if (context?.previous) {
                queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: variables.threadId }), context.previous);
            }
        },
    });
}
```

#### Multiple Mutations Pattern

```tsx
import { useMutation } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

function PromptManager() {
    const crpc = useCRPC();

    // Define all mutations
    const createMutation = useMutation(crpc.prompts.functions.createPrompt.mutationOptions());
    const updateMutation = useMutation(crpc.prompts.functions.updatePrompt.mutationOptions());
    const deleteMutation = useMutation(crpc.prompts.functions.deletePrompt.mutationOptions());
    const toggleFavoriteMutation = useMutation(crpc.prompts.functions.togglePromptFavorite.mutationOptions());

    // Use with callbacks
    const handleDelete = async (promptId: string) => {
        await deleteMutation.mutateAsync(
            { promptId },
            {
                onError: (error) => toast.error(error.message),
                onSuccess: () => toast.success("Deleted!"),
            },
        );
    };
}
```

#### Query Keys for Cache Management

```tsx
import { useCRPC } from "@/lib/lunora/crpc";

function useCacheManagement() {
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    // Invalidate specific query
    const invalidateThread = (threadId: string) => {
        queryClient.invalidateQueries({
            queryKey: crpc.chat.functions.getThread.queryKey({ threadId }),
        });
    };

    // Invalidate all threads queries
    const invalidateAllThreads = () => {
        queryClient.invalidateQueries({
            queryKey: ["chat", "functions", "getThreads"],
        });
    };

    // Prefetch data
    const prefetchThread = (threadId: string) => {
        queryClient.prefetchQuery(crpc.chat.functions.getThread.queryOptions({ threadId }));
    };
}
```

#### Real-Time Subscriptions

cRPC queries are live: `lib/lunora/live-queries.ts` subscribes every active
Lunora query over the WebSocket and pushes results into the TanStack cache (see
the Frontend notes in the root `AGENTS.md` for cost and caveats). Opt out with
`live: false`:

```tsx
const { data } = useQuery(
    crpc.chat.functions.searchThreads.queryOptions(
        { searchQuery, paginationOpts },
        { live: false }, // one-shot fetch: per-keystroke, heavy, or already live elsewhere
    ),
);
```

#### Actions (NOT via cRPC)

Actions do not go through cRPC query options. `useAction` comes from
`@/lib/lunora/crpc` — it wraps `client.action()` from `@lunora/react`. Nothing else needs importing:

```tsx
import { api } from "@neore/backend/api";

import { useAction } from "@/lib/lunora/crpc";

function MyComponent() {
    // Nested by folder and file: `backend/lunora/prompts/functions.ts` is `api.prompts.functions`.
    const getPromptTags = useAction(api.prompts.functions.getPromptTags);

    const handleLoadTags = async () => {
        const tags = await getPromptTags({});
    };
}
```

Pick the reference off `api`, not `internal`. The backend generates both —
`ApiTypes` (`api`, in `_generated/api.ts`) and `InternalApiTypes` (`internal`,
in `_generated/internal.ts`, which this app never imports) — and the same
namespace name appears in both. An internal action
such as `internal.chat.functions.generateImage` takes a `userId` argument
precisely because no client calls it; it is reachable only from another backend
function, and `useAction` cannot invoke it.

For an action as a TanStack mutation, `useLunoraActionOptions(ref)` returns
ready-made `mutationOptions`.

#### Paginated Message Hooks (useUIMessages, etc.)

`useUIMessages` is **ours** (`@/lib/agent`, ported during the migration), not a
cRPC leaf — and it is the one place `"skip"` is still correct, because it takes
that sentinel rather than a TanStack `queryFn`:

```tsx
import { api } from "@neore/backend/api";

import { useUIMessages } from "@/lib/agent";

// ✅ "skip" is right HERE — this hook is not cRPC/TanStack Query
const { results } = useUIMessages(
    api.chat.functions.getThreadUIMessages,
    threadId ? { threadId } : "skip", // ✅ OK here
    { initialNumItems: 100, stream: true },
);
```

#### In Route Loaders (Static - No Hooks)

```tsx
import { api } from "@neore/backend/api";

import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

export const Route = createFileRoute("/chat/$threadId")({
    loader: async ({ context, params }) => {
        // `useCRPC` is a hook, so loaders use the static helper instead. It takes
        // the LunoraClient off the route context and an `api.*` reference.
        await context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThread, { threadId: params.threadId }));

        // Prefetch (non-blocking)
        void context.queryClient.prefetchQuery(
            createLunoraQueryOptions(context.lunoraClient, api.chat.functions.getThreadUIMessages, {
                paginationOpts: { cursor: null, numItems: 100 },
                threadId: params.threadId,
            }),
        );
    },
});
```

### Authentication

Auth is Better Auth's own stack, and the
Lunora client is told about the token imperatively:

```tsx
// routes/__root.tsx — in beforeLoad, before any query runs
const token = await getSessionToken();

if (token) {
    context.context.lunoraClient.setAuthToken(token);
}
```

`AuthRecovery` (defined in `__root.tsx`) watches `useLunoraAuth()` and refetches
active queries when the user logs in, which covers the window where the session
cookie has landed but the RPC token has not. **`<Unauthenticated>` means "no
token", not "no session"** — see the root `AGENTS.md` for why widening that gate
is the wrong fix.

Unauthorized handling is centralised in `lib/lunora/query-client.ts` rather than
in provider props: `isAuthError` gets two retries (to cover the token-refresh
race), and `isRateLimitedError` / `isForbiddenError` are never retried.

### Type Inference

`inferApiInputs` / `inferApiOutputs` are gone. Use
`ArgsOf` / `ReturnOf` from `@lunora/react` against a flat `api.*` reference:

```tsx
import type { ArgsOf, ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";

// Per-function, not a whole-API map.
type ThreadRow = NonNullable<ReturnOf<typeof api.chat.functions.getThread>>;
type CreateThreadInput = ArgsOf<typeof api.chat.functions.createThread>;
```

Note these take `typeof api.x` (a value), not `typeof api` — there is no
`ApiOutputs["chat"]["functions"]` index chain any more.

### Documentation & Resources

- **Lunora upstream defects**: none open. The constraints that outlived them — a
  factory-assigned export is dropped from `api.ts` by design, and what must not be
  re-filed — are in the root `AGENTS.md`.
- **Lunora agent skills**: `.agents/skills/lunora*` (`lunora`, `lunora-functions`, `lunora-migration-helper`, `lunora-realtime`, …) — start with the `lunora` skill
- **TanStack Query Docs**: https://tanstack.com/query/latest
- **Generated API**: `@neore/backend/api` (from `backend/lunora/_generated/`). The shim has no `meta` object.

## TANSTACK START PATTERNS

The app follows TanStack Start best practices for server functions, authentication, and SSR.

### Server Functions with Input Validation

**Always validate server function inputs with Zod schemas**:

```typescript
// ✅ GOOD: Runtime validation prevents injection attacks
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const localeSchema = z.enum(["en", "de"]);

const updateLocale = createServerFn({ method: "POST" })
    .validator(localeSchema) // Runtime validation
    .handler(async ({ data }) => {
        // data is typed as 'en' | 'de' and validated
        setResponseHeader("Set-Cookie", serialize("locale", data, { path: "/" }));
    });

// ❌ BAD: No validation, security risk
const updateLocale = createServerFn({ method: "POST" })
    .inputValidator((locale: string) => locale) // Just type casting
    .handler(async ({ data }) => {
        // data could be anything!
    });
```

**Example**: See `functions/update-locale.ts`

### File Organization Conventions

The target convention separates server and client code by suffix. `lib/auth/`
still uses the bare names and its README lists the pending renames:

```text
lib/auth/
├── server.ts            # Server-only (Better Auth config, token handling) — becomes auth.server.ts
├── server-functions.ts  # createServerFn wrappers (safe to import) — becomes auth.functions.ts
├── client.ts            # Browser-only Better Auth client — becomes auth.client.ts
└── route-guard.ts       # requireSession for beforeLoad
```

**Rules** (once suffixed):

- `.server.ts` files: Build error if imported on client
- `.functions.ts` files: Auto-converted to RPC calls
- Can `import type` from `.server.ts` safely
- Results in smaller client bundles

**Example**: See `lib/auth/README.md` for migration strategy

### Authentication: Layout-Based Route Protection

Guard the layout route's `beforeLoad` with `requireSession` instead of checking
`context.isAuthenticated` by hand. It redirects to sign-in only when the backend
answered "no session"; a failed session read lets the page render:

```typescript
// routes/dashboard/route.tsx - guarded layout
import { requireSession } from "@/lib/auth/route-guard";

export const Route = createFileRoute("/dashboard")({
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    loader: async ({ context }) => {
        // No token yet: these would fail unauthenticated, so let AuthRecovery fetch them.
        if (!context.isAuthenticated) {
            return;
        }

        await context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.auth.functions.getCurrentUser, {}));
    },
});
```

**Benefits**:

- ✅ Nothing loads if unauthenticated (security)
- ✅ No render flashes (UX)
- ✅ No duplication across routes

**Pattern Note**: There is no `_authenticated/` layout. Eleven route files call
`requireSession` (dashboard, admin, …); `(chat)/route.tsx` gates its component
with Lunora's `<Authenticated>` and keeps its loader behind `isAuthenticated`.
New guarded routes call `requireSession` in their own layout.

### Custom Error Classes

Use structured error classes for consistent error handling:

```typescript
import type { AppError } from "@/lib/errors";
import { AuthenticationError, ServerError, ValidationError } from "@/lib/errors";

// Server function
export const updateUser = createServerFn()
    .validator(userSchema)
    .handler(async ({ data }) => {
        try {
            return await db.users.update(data);
        } catch (error) {
            throw new ServerError("Update failed", { context: { error } });
        }
    });

// Client handling
const mutation = useMutation({
    mutationFn: updateUser,
    onError: (error: AppError) => {
        if (error.code === "VALIDATION_ERROR") {
            setFieldErrors(error.field);
        } else if (error.code === "AUTHENTICATION_ERROR") {
            navigate("/auth/sign-in");
        } else {
            toast.error(error.message);
        }
    },
});
```

Each class sets its own `code` (`ValidationError` → `VALIDATION_ERROR`,
`AuthenticationError` → `AUTHENTICATION_ERROR`, …).

**Example**: See `lib/errors/index.ts`

### Hydration Safety

Defer browser API access until after hydration:

```typescript
// ✅ GOOD: Hydration-safe
export const useFont = () => {
    const [font, setFont] = useState("inter");
    const [isHydrated, setIsHydrated] = useState(false);

    useEffect(() => {
        setIsHydrated(true);
        const stored = localStorage.getItem("font");

        if (stored) setFont(stored);
    }, []);

    useEffect(() => {
        if (!isHydrated) return; // Skip during SSR

        document.body.className = font;
        localStorage.setItem("font", font);
    }, [font, isHydrated]);
};

// ❌ BAD: Hydration mismatch
export const useFont = () => {
    const [font, setFont] = useState("inter");

    useEffect(() => {
        const stored = localStorage.getItem("font"); // ⚠️ Not SSR-safe

        if (stored) setFont(stored);
    }, []);
};
```

**Example**: See `hooks/use-font.ts`

## CONVENTIONS

- **Feature-based**: Organize by domain (auth, chat, etc.)
- **TanStack Router**: File-based routing in routes/ directory
- **TanStack Start**: SSR with Cloudflare Workers deployment
- **Cache single source**: Query is authoritative (`defaultPreloadStaleTime: 0`)
- **Loader prefetching**: Use `ensureQueryData` in loaders for waterfall-free navigation
- **Input validation**: Always use Zod schemas in server functions
- **File organization**: Use `.server.ts` / `.functions.ts` / `.client.ts` suffixes (target; see `lib/auth/README.md`)
- **Route protection**: Use `beforeLoad` in layout routes, not component-level checks
- **Error handling**: Use custom error classes from `lib/errors/index.ts`
- **Hydration safety**: Track `isHydrated` state before accessing browser APIs
- **TypeScript**: Strict mode throughout
- **Component composition**: Prefer composition over inheritance
- **cRPC for data**: Always use cRPC patterns for backend queries/mutations
- **Actions stay direct**: Use `useAction` from `@/lib/lunora/crpc` for actions
- **Context-based clients**: Pass QueryClient via Router context, not globals

## ANTI-PATTERNS

- Don't bypass authentication hooks
- Don't use direct DOM manipulation
- Don't create components without proper TypeScript types
- Don't mix concerns (keep features isolated)
- **Don't import a second data-client library.** Use cRPC, and
  `createLunoraQueryOptions` from `@/lib/lunora/crpc` for static contexts. The
  generics `assert`, `BetterOmit`, `Expand` and `ErrorMessage` live in
  `src/lib/agent/type-utilities.ts`.
- **Don't attach a chat file with `attachmentAdapter.add()` alone** — `add`
  only validates; `upload` (`add` + `send`) is what stores the file and puts its
  id in `metadata.fileId`. The composer used to call only `add`, so no attachment
  reached `/chat/start` (`fileIds` was always empty) and nothing failed.
  Size limits live in `attachmentSizeLimit` (documents: the parser's 25 MB from
  `@neore/backend/document-limits`).
- **Don't use the flattened `api.chat_functions.getThread` form** — the reference
  nests by folder and file (`api.chat.functions.getThread`), and so does the `crpc` shim.
- **Don't use `"skip"` string with cRPC queryOptions** - use `skipToken` from `@tanstack/react-query` instead. `"skip"` is correct **only** for `useUIMessages` and the other paginated hooks in `@/lib/agent`, which take that sentinel directly.
- **Don't use braceless single-line if statements** — always use braces even for single-statement bodies:

    ```typescript
    // ❌ BAD
    if (condition) return;

    // ✅ GOOD
    if (condition) {
    }
    ```
