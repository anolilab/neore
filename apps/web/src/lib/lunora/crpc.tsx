/**
 * The `crpc` surface, over `@lunora/react`.
 *
 * 252 call sites across 94 files read
 * `crpc.&lt;namespace>.&lt;module>.&lt;fn>.queryOptions(args)` / `.mutationOptions()`.
 * Rewriting each to `lunoraQueryOptions(client, api.ns.module.fn, args)` is
 * mechanical but touches almost every feature directory at once, which is a bad
 * shape for a migration that still has a backend to finish. So the shape stays
 * and the implementation moves — the same trade that made `lib/lunoraCompat.ts`
 * work on the backend.
 *
 * ## The one thing to know
 *
 * `crpc.chat.functions.getThreads` is `api.chat.functions.getThreads`: the
 * Proxy below walks the generated `api` along the same path, so a typo fails at
 * that lookup with a clear message rather than resolving to a deep proxy that
 * yields a wrong function name at call time (the failure an untyped `anyApi` has).
 *
 * ## What is NOT reproduced
 *
 * The earlier `useCRPCClient` returned a client with `.query()` / `.mutation()`
 * escape hatches. `useLunora()` is that client, so it is re-exported under the
 * old name rather than wrapped.
 *
 * This file is a bridge. New code should call `lunoraQueryOptions` and
 * `useMutation` from `@lunora/react` directly; this exists so the existing 252
 * do not all have to change in one commit.
 */
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/react";
import { lunoraQueryOptions, useAuthState, useLunora } from "@lunora/react";
import type { ApiTypes } from "@neore/backend/api";
import { api } from "@neore/backend/api";
import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import { hashKey, skipToken } from "@tanstack/react-query";
import { useMemo } from "react";

import { getLiveQueryManager, LIVE_ARGS_META_KEY, LIVE_META_KEY } from "./live-queries";
import { shardOptionsFor } from "./shard-routing";

/** A leaf of the `crpc` proxy — what a call site actually invokes. */
interface CrpcLeaf<F> {
    /**
     * TanStack Mutation options. Mirrors the `mutationOptions` helper's shape.
     *
     * Takes optional overrides, which is the form `src/AGENTS.md` documents and
     * shows in its examples (`mutationOptions({ onSuccess, onError })`). The shim
     * originally took none, so those call sites read as "expected 0 arguments,
     * but got 1" — an error that points at the CALLER for following the
     * documented convention.
     */
    mutationOptions: (overrides?: Omit<UseMutationOptions<ReturnOf<F>, Error, ArgsOf<F>>, "mutationFn">) => UseMutationOptions<ReturnOf<F>, Error, ArgsOf<F>>;

    /**
     * The query key alone, for cache reads and invalidation.
     *
     * `src/AGENTS.md` documents `crpc.x.y.queryKey(args)` and nine call sites used
     * it; the shim only had `queryOptions`, so those had to spell out
     * `.queryKey(args)` instead. Same key either way — this just
     * gives the documented form somewhere to land.
     */
    queryKey: (args?: ArgsOf<F>) => ReadonlyArray<unknown>;

    /**
     * TanStack Query options. Mirrors the `queryOptions` helper's shape.
     *
     * `skipToken` is accepted because it is this codebase's convention for a
     * conditional query (see `apps/web/CLAUDE.md`: "skipToken not 'skip'") — 74
     * call sites across 30 files pass it. Omitting it from the signature made
     * every one of them `Argument of type 'unique symbol | {…}' is not
     * assignable`, which reads as a problem with the ARGS rather than with the
     * shim that forgot the convention.
     */
    queryOptions: (
        args?: ArgsOf<F> | typeof skipToken,
        options?: CrpcQueryOptions,
    ) => {
        meta?: Record<string, unknown>;
        queryFn: ((context: { queryKey: QueryKey }) => Promise<ReturnOf<F>>) | typeof skipToken;
        queryKey: ReadonlyArray<unknown>;
        staleTime: number;
    };
}

/** Per-call options for `crpc.x.y.queryOptions(args, options)`. */
export interface CrpcQueryOptions {
    /**
     * `false` makes the query a one-shot fetch instead of a live subscription
     * (see `live-queries.ts`). Live is the default; opt out for searches keyed
     * per keystroke, heavy aggregates, and anything already live through a
     * Lunora hook on the same data.
     *
     * The policy has ONE mechanism: this flag (or a `NEVER_LIVE` path) becomes
     * `meta.lunoraLive === false`, the only thing the live-query manager reads.
     * A query without it is live; nothing ever writes `true`.
     */
    live?: boolean;
}

/** `"<module>:<function>"` paths under `Tree`, the module's segments joined by `_` as codegen's dispatch keys are. */
type PathsOf<Tree, Module extends string> = {
    [Key in keyof Tree & string]: Tree[Key] extends FunctionReference ? `${Module}:${Key}` : PathsOf<Tree[Key], Module extends "" ? Key : `${Module}_${Key}`>;
}[keyof Tree & string];

/** `"module:function"` for every public procedure — the `__lunoraRef` an `api.*` reference carries. */
export type ApiPath = PathsOf<ApiTypes, "">;

/**
 * Queries that are never live, whatever the call site says: each would re-run
 * on the single `__root__` Durable Object on every write to the tables it reads,
 * for no visible benefit.
 *
 * - Search and slug checks are keyed per keystroke — every keystroke would be
 *   a new subscription lingering for `LINGER_MS`, against a 32-per-socket cap.
 * - Admin aggregates and GDPR/cleanup previews scan whole tables; a push per
 *   write buys nothing on a report page.
 * - Public catalogs change on deploys, not on user writes.
 * - Admin/impersonation flags are on every page and change about never; each
 *   live query is a seed on first paint (see `MAX_CONCURRENT_SEEDS`).
 *
 * Typed against the generated paths, so a renamed or removed procedure fails
 * the typecheck here instead of silently going live again.
 */
const NEVER_LIVE: ReadonlySet<string> = new Set<ApiPath>([
    "admin_cleanup:previewCleanup",
    "auth_admin:checkUserAdminStatus",
    "auth_admin:getDashboardStats",
    "auth_admin:isCurrentUserAdmin",
    "auth_admin:isImpersonating",
    "auth_organization:checkSlug",
    "chat_functions:searchMessages",
    "chat_functions:searchThreads",
    "connectors_user_connectors:listConnectorCatalog",
    "evals_functions:compareRuns",
    "gdpr_functions:getDataAccessSummary",
    "pages_functions:searchPages",
    "skills_marketplace:browseSkills",
    "skills_marketplace:searchSkills",
    "workflow_gallery:browseGallery",
    "workflow_gallery:getFeaturedWorkflows",
]);

/**
 * The generated `api` is a tree of namespaces with bare `FunctionReference`s at
 * its leaves. The earlier `crpc` helper presented each leaf as an object with
 * `queryOptions` / `mutationOptions`, so every leaf has to be lifted — otherwise
 * every call site reports `Property 'queryOptions' does not exist on type
 * 'FunctionReference&lt;…>'` (179 of them did).
 */
type CrpcTree<Tree> = { [Key in keyof Tree]: Tree[Key] extends FunctionReference ? CrpcLeaf<Tree[Key]> : CrpcTree<Tree[Key]> };
type CrpcApi = CrpcTree<ApiTypes>;

const isReference = (value: unknown): value is FunctionReference =>
    typeof value === "object" && value !== null && "__lunoraRef" in value && typeof value.__lunoraRef === "string";

/**
 * `["chat", "functions", "getThreads"]` -> `api.chat.functions.getThreads`.
 *
 * Throws rather than returning undefined: a bad path is a programming error, and
 * the message that names the attempted key is worth far more than a downstream
 * "cannot read property of undefined".
 */
const resolve = (path: string[]): FunctionReference => {
    let node: unknown = api;

    for (const segment of path) {
        node = typeof node === "object" && node !== null && Object.hasOwn(node, segment) ? (node as Record<string, unknown>)[segment] : undefined;
    }

    if (!isReference(node)) {
        throw new Error(`crpc.${path.join(".")} does not exist — expected a procedure at api.${path.join(".")}.`);
    }

    return node;
};

// The Proxy is untyped by construction — `CrpcApi` is asserted once, at
// `useCRPC`. Typing this factory precisely would mean threading the leaf's
// FunctionReference through a Proxy `get`, which TypeScript cannot express.
/* eslint-disable @typescript-eslint/no-explicit-any */
const leaf = (client: LunoraClient, path: string[]): any => {
    return {
        mutationOptions: (overrides?: object) => {
            return {
                mutationFn: async (args: Record<string, unknown>) => await client.mutation(resolve(path) as never, args as never, shardOptionsFor(args)),
                ...overrides,
            };
        },
        queryKey: (args: unknown = {}) => lunoraQueryOptions(client, resolve(path), args as never, shardOptionsFor(args)).queryKey,
        queryOptions: (args: unknown = {}, options?: CrpcQueryOptions) => {
            // `skipToken` short-circuits before `resolve(path)`, so a skipped query
            // does not even look the function up — which matters, because `resolve`
            // throws on an unknown path. It also never subscribes: a skipped query
            // is never active, which is what keeps auth-gated queries off the
            // socket until their token exists.
            if (args === skipToken) {
                return { queryFn: skipToken, queryKey: [...path, "skipped"], staleTime: 0 };
            }

            const reference = resolve(path);
            // A shared thread's or page's calls go to its owner's shard (`shard-routing.ts`).
            const base = lunoraQueryOptions(client, reference, args as never, shardOptionsFor(args));
            const live = options?.live ?? !NEVER_LIVE.has((reference as unknown as { __lunoraRef: string }).__lunoraRef);

            if (!live) {
                return { ...base, meta: { [LIVE_META_KEY]: false } };
            }

            return {
                ...base,
                meta: { [LIVE_ARGS_META_KEY]: args ?? {} },
                // Answers from the open subscription when there is one; a plain
                // RPC during SSR, in loaders, and before the manager is installed.
                queryFn: async ({ queryKey }: { queryKey: QueryKey }) => {
                    const manager = getLiveQueryManager(client);

                    return manager
                        ? await manager.fetch(queryKey, hashKey(queryKey), reference as never, (args ?? {}) as Record<string, unknown>)
                        : await base.queryFn();
                },
            };
        },
    };
};

const LEAF_PROPERTIES = new Set(["mutationOptions", "queryKey", "queryOptions"]);

/**
 * Walks path segments until a call site reads `queryOptions` / `mutationOptions`,
 * which is what makes an arbitrary-depth `crpc.a.b.c` work without enumerating it.
 */
const node = (client: LunoraClient, path: string[]): unknown =>
    new Proxy(
        {},
        {
            get(_target, property) {
                if (typeof property !== "string") {
                    return undefined;
                }

                // `queryKey` belongs here too. It is declared on the leaf type and
                // implemented above, but leaving it out of this check meant the
                // proxy treated it as another path segment and returned a
                // non-callable `Proxy({})` — so every `crpc.x.y.queryKey(args)`
                // threw `queryKey is not a function` at runtime while typechecking
                // clean. Two of the three call sites sat inside `sendMessage`'s
                // try block, where the throw was swallowed by the catch that
                // strips the optimistic message.
                if (LEAF_PROPERTIES.has(property)) {
                    return leaf(client, path)[property];
                }

                return node(client, [...path, property]);
            },
        },
    );

/** The `crpc` object, typed to match the earlier surface so call sites keep their inference. */
export const useCRPC = (): CrpcApi => {
    const client = useLunora();

    // Memoised on the client: rebuilding the proxy every render would give every
    // `queryOptions(...)` a fresh identity and defeat TanStack's structural
    // sharing on the query key.
    return useMemo(() => node(client, []) as CrpcApi, [client]);
};

export { LunoraProvider as CRPCProvider, type LunoraClient as LunoraReactClient, useLunora as useCRPCClient, useLunora, useMutation } from "@lunora/react";

// ---------------------------------------------------------------------------
// Lunora react helpers & exports
// ---------------------------------------------------------------------------

/**
 * `useAction(ref)` — Lunora action invocation hook.
 */
export const useAction = <F extends FunctionReference>(reference: F): ((args: ArgsOf<F>) => Promise<ReturnOf<F>>) => {
    const client = useLunora();

    return useMemo(() => async (args: ArgsOf<F>) => await client.action(reference as never, args as never, shardOptionsFor(args)), [client, reference]);
};

/**
 * `useLunoraActionOptions(ref)` — TanStack mutation options that invoke a Lunora action.
 */
export const useLunoraActionOptions = <F extends FunctionReference>(reference: F): UseMutationOptions<ReturnOf<F>, Error, ArgsOf<F>> => {
    const client = useLunora();

    return useMemo(() => {
        return { mutationFn: async (args: ArgsOf<F>) => await client.action(reference as never, args as never, shardOptionsFor(args)) };
    }, [client, reference]);
};

/**
 * `useLunoraAuth()` — Lunora's `{ isAuthenticated, isLoading }`.
 */
export const useLunoraAuth = (): { isAuthenticated: boolean; isLoading: boolean } => {
    const state = useAuthState();

    return { isAuthenticated: state.isAuthenticated, isLoading: state.isLoading };
};

/**
 * `createLunoraQueryOptions(client, ref, args)` — query options for route loaders.
 */
export const createLunoraQueryOptions = <F extends FunctionReference>(client: LunoraClient, reference: F, args: ArgsOf<F>) =>
    lunoraQueryOptions(client, reference, args, shardOptionsFor(args));

/**
 * Query options whose fetch is a Lunora ACTION — for reads that must run as an
 * action, like the anonymous share pages (`getPublicThread`, `getPublicPage`,
 * `getPublicWorkflow`): the row lives on its owner's shard, and only the server
 * may hop there. Never live; an action has no subscription.
 */
export const createLunoraActionQueryOptions = <F extends FunctionReference>(client: LunoraClient, reference: F, args: ArgsOf<F>) => {
    return {
        queryFn: async (): Promise<ReturnOf<F>> => await client.action(reference as never, args as never),
        queryKey: ["lunora-action", (reference as unknown as { __lunoraRef: string }).__lunoraRef, args] as const,
    };
};
