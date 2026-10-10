/**
 * Procedure builders — the Lunora port of the former cRPC layer.
 *
 * Every public backend function is built from one of the exports below. The
 * shape is deliberately identical to the earlier version (`publicQuery`,
 * `authQuery`, `authMutation`, `adminAction`, …) so the ~470 ported handlers
 * only changed their *body*, not which builder they hang off.
 *
 * IMPORTANT — where the builders come from. These are re-exported from
 * `../_generated/server`, NOT from `initLunora.dataModel<DataModel>().create()`.
 * `create()` returns the bare `LunoraBuilders`, whose `QueryCtx`/`MutationCtx`
 * are *unparameterised* — the `DataModel` passed to `dataModel<DM>()` is, in
 * alpha.40, only a phantom ("reserved for typed `ctx.db`"). Codegen is what
 * binds `ctx.db` / `ctx.storage` to this project's schema. Building on `create()`
 * directly silently erases `ctx.db`'s type through the whole chain.
 *
 * Two things differ from the earlier original, both forced by Lunora:
 *
 *  - **No `.meta()`.** The earlier layer carried per-procedure policy as metadata that
 *    middleware read back (`.meta({ rateLimit: "pins/create" })`). Lunora's
 *    builder had `.input()` / `.output()` / `.use()` and nothing else, so policy
 *    is now explicit middleware: `.use(rateLimit("pins/create"))`. `.meta()` has
 *    since landed upstream, but the explicit form is kept deliberately: the
 *    middleware is visible at the call site instead of resolved from metadata.
 *  - **`shouldAllowAnonymous` is a builder choice, not a flag.** Where the earlier layer branched
 *    inside one middleware on `meta.shouldAllowAnonymous`, there are now two builders
 *    (`authQuery` vs `optionalAuthQuery`), which is also what makes `ctx.user`
 *    non-nullable on the authed variants without a cast.
 *
 * Middleware that only *inspects* the context is generic in it and returns
 * `next()` unchanged, so the context type flows through untouched. Middleware
 * that *widens* the context is written inline at the `.use()` site and passes
 * only the extension to `next({ ctx })` — Lunora shallow-merges it, and
 * inference carries the widened type into every downstream handler.
 */
import { platformAdmin } from "@lunora/server";
import type { Middleware } from "lunorash/server";
import { LunoraError } from "lunorash/server";

import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../_generated/server";
import { action as generatedAction, mutation as generatedMutation, query as generatedQuery } from "../_generated/server";
import { ENVIRONMENT } from "../env";
import type { SessionUser } from "./auth-types";
import { getSessionUser, getSessionUserForQuery, getSessionUserForQueryLite, getSessionUserWithAnonymous } from "./crpc-auth-helpers";
import type { RateLimitName } from "./rate-limiter";
import { rateLimitGuard } from "./rate-limiter";
import { rowLevelSecurity } from "./rls/policies";
import { withRlsScope } from "./rls/scope";

export { internalAction, internalMutation, internalQuery } from "../_generated/server";

/** Context shape any auth-aware middleware can rely on. */

interface WithUser {
    user?: SessionUser | null;
}

// ---------------------------------------------------------------------------
// Context-preserving middleware
// ---------------------------------------------------------------------------

/**
 * Blocks a procedure outside development. Replaces `.meta({ requireDevelopment: true })`.
 *
 * OPT-IN, per procedure: `.use(requireDevelopment())`. It must never sit in a
 * base builder below — it once did, under every query, mutation and action,
 * which would have answered FORBIDDEN to ~210 procedures on the first deploy
 * (`alchemy.run.ts` sets `ENVIRONMENT` to `production`/`preview`). The earlier
 * factories had it as an opt-in flag defaulting to off; `crpc.test.ts` pins both
 * directions.
 *
 * `ENVIRONMENT` reads as `""` when unset, which counts as NOT development — the
 * safe direction for a gate whose failure mode is "debug tool live in production".
 *
 * Generic in the context and returns `next()` with no extension, so the caller's
 * context type passes through untouched.
 */
export const requireDevelopment =
    <C>(): Middleware<C, C> =>
    ({ next }) => {
        if (ENVIRONMENT !== "development") {
            throw new LunoraError("FORBIDDEN", "This function is only available in development");
        }

        return next();
    };

/**
 * Replaces `.meta({ rateLimit: "<name>" })`. Counts the call against the caller: the user
 * when signed in, otherwise the client IP (see `rateLimitGuard`). Must sit after `.input(...)`.
 */
/** `rateLimit` for a bare builder (`mutation`, `publicAction`) with no `ctx.user`; the second overload is picked only when the first does not fit. */
export function rateLimit<C>(name: RateLimitName): Middleware<C, C>;
/** `rateLimit` for an authenticated builder: the context type is the builder's own. */
export function rateLimit<C extends WithUser>(name: RateLimitName): Middleware<C, C>;
export function rateLimit<C>(name: RateLimitName): Middleware<C, C> {
    return async ({ ctx, next }) => {
        // Not every builder carries `user` (bare `mutation`, `publicAction`): then it is
        // absent here, and the call counts as the public tier.
        const user = (ctx as WithUser).user ?? null;

        await rateLimitGuard({
            ...ctx,
            rateLimitKey: name,
            user: user ? { plan: user.plan, userId: user.userId } : null,
        } as never);

        return next();
    };
}

const unauthorized = () => new LunoraError("UNAUTHORIZED", "Please sign in to continue");

// ---------------------------------------------------------------------------
// Row-level security
// ---------------------------------------------------------------------------
//
// Every CLIENT-REACHABLE builder below ends in `withRlsScope` + `rls(POLICIES)`
// (see `lib/rls/`), AFTER its auth middleware so the scope knows `ctx.user`.
// Each chain is spelled out from the generated builder rather than derived from
// another guarded one: RLS layers AND together, so an admin builder derived
// from `authQuery` could never widen what the user policies allow.
//
// Actions are not guarded: an action reaches the database only through
// `runQuery`/`runMutation`, which land on a guarded public procedure or on an
// internal (system) one. `rls.guard.test.ts` pins that no action uses `ctx.db`.

const guardedAs = { admin: { admin: true }, user: { admin: false } } as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The bare builder, guarded. Procedures on it resolve identity themselves
 * (`getAuthUserIdentity`); RLS keys off `ctx.auth.userId` either way.
 */
export const query = generatedQuery.use(withRlsScope(guardedAs.user)).use(rowLevelSecurity());

export const publicQuery = query;

export const optionalAuthQuery = generatedQuery
    .use(async ({ ctx, next }) => {
        const user = await getSessionUserForQuery(ctx as never);

        return next({ ctx: { user } });
    })
    .use(withRlsScope(guardedAs.user))
    .use(rowLevelSecurity());

const authenticatedQuery = generatedQuery.use(async ({ ctx, next }) => {
    const user = await getSessionUserForQuery(ctx as never);

    if (!user) {
        throw unauthorized();
    }

    return next({ ctx: { user } });
});

export const authQuery = authenticatedQuery.use(withRlsScope(guardedAs.user)).use(rowLevelSecurity());

export const authPaginatedQuery = authQuery;

/**
 * JWT-only auth (zero DB reads) for read-only hot paths that need nothing but
 * `userId` — no ban check, org context, or admin flag. Skips the session lookup.
 */
export const liteAuthQuery = generatedQuery
    .use(async ({ ctx, next }) => {
        const user = await getSessionUserForQueryLite(ctx as never);

        if (!user) {
            throw unauthorized();
        }

        return next({ ctx: { user } });
    })
    .use(withRlsScope(guardedAs.user))
    .use(rowLevelSecurity());

/** Platform admins: the policies allow every row (the handler is the whole check, as before RLS). */
export const adminQuery = authenticatedQuery
    .use(platformAdmin<QueryContext & { user: SessionUser }>((ctx) => ctx.user?.isAdmin === true))
    .use(withRlsScope(guardedAs.admin))
    .use(rowLevelSecurity());

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** The bare builder, guarded — see {@link query}. */
export const mutation = generatedMutation.use(withRlsScope(guardedAs.user)).use(rowLevelSecurity());

const sessionMutation = generatedMutation.use(async ({ ctx, next }) => {
    const user = await getSessionUser(ctx as never);

    return next({ ctx: { user } });
});

export const publicMutation = sessionMutation.use(withRlsScope(guardedAs.user)).use(rowLevelSecurity());

export const optionalAuthMutation = generatedMutation
    .use(async ({ ctx, next }) => {
        const user = await getSessionUserWithAnonymous(ctx as never, true);

        return next({ ctx: { user } });
    })
    .use(withRlsScope(guardedAs.user))
    .use(rowLevelSecurity());

const authenticatedMutation = generatedMutation.use(async ({ ctx, next }) => {
    const user = await getSessionUser(ctx as never);

    if (!user) {
        throw unauthorized();
    }

    return next({ ctx: { user } });
});

export const authMutation = authenticatedMutation.use(withRlsScope(guardedAs.user)).use(rowLevelSecurity());

export const adminMutation = authenticatedMutation
    .use(platformAdmin<MutationContext & { user: SessionUser }>((ctx) => ctx.user?.isAdmin === true))
    .use(withRlsScope(guardedAs.admin))
    .use(rowLevelSecurity());

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const action = generatedAction;

export const publicAction = action;

export const authAction = publicAction.use(async ({ ctx, next }) => {
    const user = await getSessionUser(ctx as never);

    if (!user) {
        throw unauthorized();
    }

    return next({ ctx: { user } });
});

export const adminAction = authAction.use(platformAdmin<ActionContext & { user: SessionUser }>((ctx) => ctx.user?.isAdmin === true));

// ---------------------------------------------------------------------------
// Internal (no auth; not reachable from the client)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context aliases used across the ported handlers
// ---------------------------------------------------------------------------

export type PublicQueryCtx = QueryContext & { user: SessionUser | null };
export type AuthQueryCtx = QueryContext & { user: SessionUser };
export type PublicMutationCtx = MutationContext & { user: SessionUser | null };
export type AuthMutationCtx = MutationContext & { user: SessionUser };
export type AuthActionCtx = ActionContext & { user: SessionUser };

export type { SessionUser } from "./auth-types";
