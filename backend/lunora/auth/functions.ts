import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";
import { LunoraError } from "lunorash/server";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../_generated/server";

import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { mutation, query, rateLimit } from "../lib/crpc";
import { getAuth, getSession } from "../auth";
import { ENVIRONMENT } from "../env";
import type { SessionUser } from "../lib/auth-types";
import { asyncMap } from "../lib/collections";
import { authMutation } from "../lib/crpc";
import { getSessionUserForQuery, getSessionUserForQueryLite, validateAuthUser as validateAuthUserHelper } from "../lib/crpc-auth-helpers";
import { decryptKey, encryptKey, type KeyPurpose } from "../lib/encryption";
import { throwUnauthorized } from "../lib/error-helpers";
import type { RateLimitName } from "../lib/rate-limiter";
import { rateLimitGuard } from "../lib/rate-limiter";
import { aiUserPreferencesFields, userSettingsFieldsWithoutUserId } from "./fields";
import { KEY_ENTRY_FIELDS, type KeyEntryInput, mergeKeyEntries, redactPreferences, type StoredKeyEntry } from "./lib/byok-keys";
import { getMembersByUserId, getOrganization, getUser } from "./lib/better-auth-queries";
import { getCurrentUserInternal } from "./lib/helper";
import { resolveActiveMembership } from "./lib/organization-helpers";
import { resolveUserPlan } from "./lib/plan";
import roleGuard from "./lib/role-guard";
import { withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";

/** Any context an auth helper may be called from. */
type AnyAuthContext = QueryContext | MutationContext | ActionContext;

const SHORTCUT_RE =
    /^(?:(?:ctrl|cmd|meta|alt|shift)\+)*(?:f\d{1,2}|arrowup|arrowdown|arrowleft|arrowright|space|enter|escape|tab|backspace|delete|[a-z0-9?])$/i;

/**
 * Get authenticated user from context using the auth helpers.
 * Returns SessionUser with active organization context.
 * Optimized to run queries in parallel where possible.
 * Note: This now delegates to getSessionUserForQuery from crpcAuthHelpers for consistency.
 */
const getAuthSessionUser = async (context: AnyAuthContext): Promise<SessionUser | null> => {
    try {
        return await getSessionUserForQuery(context as QueryContext);
    } catch {
        return null;
    }
};

/**
 * Infer HKDF key purpose from the top-level field name being saved.
 */
const inferKeyPurpose = (fieldName: string): KeyPurpose => {
    switch (fieldName) {
        case "customAIProviders": {
            return "custom-providers";
        }
        case "generalProviders": {
            return "tool-keys";
        }
        case "messengerKeys": {
            return "messenger-keys";
        }
        case "providerApiKeys": {
            return "provider-keys";
        }
        default: {
            throw new Error(`Unknown field name for key purpose inference: "${fieldName}"`);
        }
    }
};

/**
 * Purposes whose entries carry key metadata (createdAt, lastRotatedAt, keyVersion).
 * The columns are `v.any()`, so this is a display choice, not a schema constraint.
 */
const PURPOSES_WITH_METADATA: ReadonlySet<KeyPurpose> = new Set(["messenger-keys", "provider-keys"]);

/**
 * Columns whose entries go through `mergeKeyEntries` rather than being stored as
 * sent: every key column EXCEPT `customAIProviders`, which the settings upsert
 * never receives (`aiUserPreferencesFields` omits it). Only
 * `chat/custom-providers.ts` writes that column, because saving an endpoint also
 * validates its URL (SSRF) and binds the stored key to that URL.
 */
const KEY_INPUT_FIELDS: ReadonlySet<string> = new Set(KEY_ENTRY_FIELDS.filter((field) => field !== "customAIProviders"));

const AUTH_REQUIRED_ERROR: { code: "UNAUTHORIZED"; message: string } = {
    code: "UNAUTHORIZED",
    message: "Not authenticated",
};

const MUTATION_AUTH_REQUIRED_ERROR: { code: "UNAUTHORIZED"; message: string } = {
    code: "UNAUTHORIZED",
    message: "Not authenticated",
};

const requireUser = <T>(user: T | null, error: { code: "UNAUTHORIZED"; message: string } = AUTH_REQUIRED_ERROR): T => {
    if (!user) {
        throw new LunoraError(error.code, error.message);
    }

    return user;
};

// Helper function to check if function is dev-only
const checkDevelopmentOnly = (isDevelopmentOnly?: boolean) => {
    // Check environment variable - adapt based on your setup
    const isProduction = ENVIRONMENT !== undefined && ENVIRONMENT !== "development";

    if (isDevelopmentOnly && isProduction) {
        throw new LunoraError("FORBIDDEN", "This function is only available in development");
    }
};

// Helper function to apply rate limiting
const applyRateLimit = async (context: ActionContext | MutationContext, rateLimit: RateLimitName | null | undefined, user: SessionUser | null) => {
    if (!rateLimit) {
        return;
    }

    // Use the new rateLimitGuard helper
    await rateLimitGuard({
        ...context,
        rateLimitKey: rateLimit,
        user: user ? { plan: user.plan, userId: user.userId } : null,
    });
};

// Factory functions for settings mutations/queries
// These use standard mutation/query since they work with validators from fields.ts

/**
 * The two settings tables share a shape: one row per user, found `by_userId`.
 * Naming them rather than taking `any` is what lets `withIndex("by_userId", …)`
 * type its range callback — with `any` the `q` was implicitly `any` and a
 * misspelled index name would have compiled.
 */
export type SettingsTable = "aiUserPreferences" | "userSettings";

const settingsUpsert = async (tableName: SettingsTable, { args: inputArguments, ctx: context }: { args: Record<string, unknown>; ctx: MutationContext }) => {
    const user = await getSessionUser(context);
    const userId = user?.userId;

    if (!userId) {
        throwUnauthorized("User must be authenticated");
    }

    const settings = await context.db
        .query(tableName)
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    // Key columns merge against what is stored: plaintext arrives only as an
    // explicit per-entry `key`, and an entry without one keeps its stored
    // ciphertext untouched (see auth/lib/byok-keys.ts). All other fields
    // (e.g. mcpServers, memoryEnabled) are stored as-is.
    const toStore: Record<string, unknown> = {};
    const now = Date.now();

    for (const [fieldName, value] of Object.entries(inputArguments)) {
        if (KEY_INPUT_FIELDS.has(fieldName) && value && typeof value === "object") {
            const purpose = inferKeyPurpose(fieldName);
            const stored = (settings as Record<string, unknown> | null)?.[fieldName] as Record<string, StoredKeyEntry> | undefined;

            toStore[fieldName] = await mergeKeyEntries(
                value as Record<string, KeyEntryInput | undefined>,
                stored,
                (plaintext) => encryptKey(plaintext, purpose),
                {
                    now,
                    stampMetadata: PURPOSES_WITH_METADATA.has(purpose),
                },
            );
        } else {
            toStore[fieldName] = value;
        }
    }

    const savedKeyPurposes = Object.keys(inputArguments).filter((k) => KEY_INPUT_FIELDS.has(k));

    if (savedKeyPurposes.length > 0) {
        // Enforce BYOK save rate limit
        await rateLimitGuard({
            ...context,
            rateLimitKey: "byok/save",
            user: user ? { plan: user.plan, userId: user.userId } : null,
        });

        console.info(`[BYOK Audit] userId=${userId} action=save purposes=[${savedKeyPurposes.join(",")}] timestamp=${new Date().toISOString()}`);
    }

    if (tableName === "userSettings") {
        // Enhanced validation for shortcut format
        // Allows: single keys, modifier combinations, function keys, special keys
        const validPattern = SHORTCUT_RE;

        // `userSettings.keyboardShortcuts` is `v.any()` in the schema, so this
        // arrives as `unknown`; narrow before indexing. `String(value)` keeps the
        // original coercion semantics of `RegExp.test`.
        const shortcuts = toStore.keyboardShortcuts;

        if (shortcuts && typeof shortcuts === "object") {
            for (const value of Object.values(shortcuts as Record<string, unknown>)) {
                if (!validPattern.test(String(value))) {
                    throw new Error("Invalid keyboard shortcut");
                }
            }
        }
    }

    if (settings) {
        await context.db.patch(settings._id, toStore);
    } else {
        await context.db.insert(tableName, {
            userId,
            ...toStore,
        });
    }
};

// Generic over the table, so `getAIUserPreferences` returns
// `Doc<"aiUserPreferences">` rather than the union of both settings tables.
// Un-generic, every caller got `Doc<"aiUserPreferences"> | Doc<"userSettings">`
// and `prefs.mcpServers` — a column only one of them has — did not type-check.
const settingsGet = async <Table extends SettingsTable>(tableName: Table, { ctx: context }: { ctx: QueryContext }) => {
    // Use lightweight auth - JWT only, zero DB reads (60-80% faster, imported at top)
    const user = await getSessionUserForQueryLite(context);
    const userId = user?.userId;

    if (!userId) {
        return null;
    }

    const doc = await context.db
        .query(tableName)
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    if (!doc) {
        return null;
    }

    // Ciphertext never reaches a client: key entries come back as
    // `{ enabled, hasKey, last4?, … }` with `encryptedKey` removed. Done on a
    // spread copy rather than via a generic helper's return type, because
    // codegen reads this procedure's INFERRED return type and would widen it.
    const redacted = { ...doc };

    redactPreferences(redacted as unknown as Record<string, unknown>);

    return redacted;
};

/**
 * Get session user data with organization context for MUTATIONS (write operations).
 * Uses getAuthUser() to ensure user is actually valid - important for security.
 * For destructive operations, we need to verify the user is still valid (not revoked).
 * Can be used with MutationCtx or ActionCtx.
 */
const getSessionUser = async (context: AnyAuthContext): Promise<SessionUser | null> => await getAuthSessionUser(context);

/**
 * Get session user with anonymous support for QUERIES.
 * Uses getUserIdentity() for better performance - NO extra DB queries.
 * Note: getSessionUserForQuery already falls back to getAuthUser if getUserIdentity fails,
 * so no need for additional fallback here - that would be redundant.
 * `_shouldAllowAnonymous` is accepted and ignored: `getSessionUserForQuery` already
 * falls back to the anonymous identity, so there is nothing left for the flag to
 * switch. It stays in the signature so existing callers keep compiling.
 */
const getSessionUserWithAnonymousForQuery = async (context: QueryContext, _shouldAllowAnonymous: boolean): Promise<SessionUser | null> =>
    // getSessionUserForQuery already handles the fallback to getAuthUser
    // when getUserIdentity() is not available, so no need for double call
    await getSessionUserForQuery(context);

/**
 * Get session user with anonymous support for MUTATIONS.
 * Uses getAuthUser() to ensure user is actually valid - important for security.
 * If shouldAllowAnonymous is true and no user is found, attempts to get anonymous user from Better Auth.
 * This handles race conditions where anonymous sign-in is in progress.
 * @param context Mutation or Action context
 * @param shouldAllowAnonymous Whether to allow anonymous users
 * @returns SessionUser or null
 */
const getSessionUserWithAnonymous = async (context: AnyAuthContext, shouldAllowAnonymous: boolean): Promise<SessionUser | null> => {
    // First, try to get the user using the standard method (getAuthUser for security)
    let user = await getSessionUser(context);

    // If shouldAllowAnonymous is true and user is null, try getting the user from Better Auth
    // This handles the case where anonymous sign-in is in progress or getSessionUser failed
    // due to race conditions during initial page load
    if (!user && shouldAllowAnonymous) {
        user = await getAuthSessionUser(context);
    }

    return user;
};

/**
 * Validate and process user for auth context.
 * Delegates to the shared helper from crpcAuthHelpers.
 */
const validateAuthUser = (
    user: SessionUser | null,
    shouldAllowAnonymous: boolean,
    role?: "admin",
    error: { code: "UNAUTHORIZED"; message: string } = AUTH_REQUIRED_ERROR,
): SessionUser => validateAuthUserHelper(user, shouldAllowAnonymous, role, error);

/**
 * The response shape of {@link getCurrentUser}.
 *
 * Exported because it is the only declaration of that shape: the procedure
 * deliberately has no `.output()` (see below), so this is what consumers and the
 * handler's return annotation are both written against.
 */
export const vGetCurrentUserOutput = v.object({
    _id: v.string(),
    activeOrganization: v.optional(
        v.union(v.object({ id: v.string(), name: v.string(), role: v.string(), slug: v.optional(v.union(v.string(), v.null())) }), v.null()),
    ),
    email: v.string(),
    image: v.optional(v.union(v.string(), v.null())),
    impersonatedBy: v.optional(v.union(v.string(), v.null())),
    isAnonymous: v.optional(v.boolean()),
    name: v.union(v.string(), v.null()),
    role: v.optional(v.union(v.string(), v.null())),
    username: v.optional(v.union(v.string(), v.null())),
});

// The handler's RETURN ANNOTATION is what makes codegen print a self-contained
// type. There is deliberately no `.output(vGetCurrentUserOutput)` to match:
// `v.object` strips unknown keys, and this validator is a hand-maintained copy of
// a better-auth user plus organisation and settings fields, so a field missing
// here would vanish from every response with no error anywhere. `getStreamBody`
// in `chat/streaming/index.ts` declares its output because its type is provably
// three fields; this one is not.
// Left to inference it emitted `import("./lib/types").BetterAuthUser` into `_generated/api.ts` — a
// specifier resolved against this file's directory, which means nothing from
// `_generated/`.
export const getCurrentUser = query
    .input({})
    .query(async ({ ctx: context }): Promise<Infer<typeof vGetCurrentUserOutput> | null> => (await getCurrentUserInternal(context)) ?? null);

/**
 * Genuine boundary: `auth.api` is a plugin-assembled record whose members are only
 * known at runtime, so a probe for an optional member needs a named narrow shape.
 *
 * NOTE: `rotateKeys` does NOT exist on better-auth's api surface — it appears
 * nowhere in the resolved `better-auth` dist (checked 1.6.x/1.7.x), and the jwt
 * plugin exposes no rotate endpoint. The previous `(auth.api as any).rotateKeys()`
 * therefore threw `TypeError: ... is not a function` on every call. Nothing calls
 * this action today, so the export is kept (removing it would desync
 * `_generated/`), but it now fails with an explanation instead of a TypeError.
 */
interface RotatableAuthApi {
    rotateKeys?: () => Promise<unknown>;
}

export const rotateKeys = internalAction.input({}).action(async ({ ctx: _context }) => {
    const auth = getAuth();
    // NOT `const { api } = auth` — the intersection is what declares the optional
    // `rotateKeys?`, and without it the guard below has nothing to narrow.

    const innerApi: RotatableAuthApi & typeof auth.api = auth.api;

    if (typeof innerApi.rotateKeys !== "function") {
        throw new LunoraError(
            "INTERNAL_SERVER_ERROR",
            "auth.api.rotateKeys is not available in this better-auth build; no JWKS rotation endpoint is configured.",
        );
    }

    return innerApi.rotateKeys();
});

/**
 * Whether the caller has an email/password account.
 *
 * Reads `account` directly. It used to call better-auth's `listUserAccounts`
 * with `getHeaders()`, which forwards the session as `Authorization: Bearer` —
 * but no `bearer()` plugin is installed, so better-auth answered UNAUTHORIZED
 * for every caller, and the dashboard loader that awaits this query turned
 * every `/dashboard/*` load into a 500.
 */
export const hasPassword = query
    .input({})
    .output(v.boolean())
    .query(async ({ ctx }) => {
        const session = await getSession(ctx);

        if (!session) {
            return false;
        }

        const { page: accounts } = await ctx.db.account.findMany({ where: { userId: session.userId } });

        return accounts.some((account) => account.providerId === "credential");
    });

// Query to get session user (used by actions)
export const getSessionUserQuery = query.input({}).query(async ({ ctx: context }) => getSessionUser(context));

// Re-export SessionUser from canonical location for backward compatibility
export type { SessionUser } from "../lib/auth-types";

/**
 * Get session user writer (for mutations).
 * Similar to getSessionUser but returns a user object suitable for mutations.
 */
export const getSessionUserWriter = async (context: MutationContext): Promise<SessionUser | null> => getSessionUser(context);

/**
 * Body accepted by better-auth's organization `hasPermission` endpoint: a map of
 * resource name -> allowed actions (e.g. `{ member: ["create"] }`). Same shape as
 * `OrganizationApi.hasPermission` in `auth/organization.ts`.
 */
export interface PermissionCheckBody {
    permissions: Record<string, string[]>;
}

/**
 * Check if user has permission for a given action.
 * Uses Better Auth's permission API.
 * Requires a context with auth API access (typically from createAuthMutation/createAuthQuery).
 * @param context Context with auth API access
 * @param context.auth Better Auth API
 * @param context.auth.api.hasPermission Better Auth hasPermission API
 * @param context.auth.headers Headers from the request
 * @param body Permission check body
 * @param shouldThrow Whether to throw an error if permission is denied (default: true)
 * @returns Promise&lt;boolean> - Whether the user has permission
 */
export const hasPermission = async (
    context: {
        auth: {
            api: { hasPermission: (args: { body: PermissionCheckBody; headers: Headers }) => Promise<{ success: boolean }> };
            headers: Headers;
        };
    },
    body: PermissionCheckBody,
    shouldThrow = true,
): Promise<boolean> => {
    const canUpdate = await context.auth.api.hasPermission({
        body,
        headers: context.auth.headers,
    });

    if (shouldThrow && !canUpdate.success) {
        throw new LunoraError("FORBIDDEN", "Insufficient permissions for this action");
    }

    return canUpdate.success;
};

/**
 * List all organizations for a given user.
 * Returns organizations with the user's role in each organization.
 * Optimized: Uses parallel fetching for organizations (not N+1).
 * @param context Query or Mutation context with database access
 * @param userId The user ID to get organizations for (string)
 * @returns Array of organizations with role information
 */
export const listUserOrganizations = async (
    context: QueryContext | MutationContext,
    userId: string,
): Promise<
    {
        _creationTime: number;
        // `organization` IS a table in `lunora/schema.ts`, so the id is branded.
        _id: Id<"organization">;
        logo: string | null;
        name: string;
        // Carried through so callers can pass the row straight to
        // `isOrganizationOwner()` as its pre-fetched `org` argument; without it
        // the owner fast path silently degraded to an extra `member` lookup.
        ownerId?: string;
        role: string;
        slug?: string;
    }[]
> => {
    // Query memberships by userId using the userId index
    const memberships = await getMembersByUserId(context, userId);

    if (!memberships || memberships.length === 0) {
        return [];
    }

    // Fetch all organizations in parallel using asyncMap (concurrent execution)
    const results = await asyncMap(memberships, async (membership) => {
        // Get the organization document
        const org = await getOrganization(context, membership.organizationId);

        if (!org) {
            // Return null for missing orgs, filter out below
            return null;
        }

        return {
            _creationTime: org._creationTime,
            _id: org._id,
            logo: org.logo || null,
            name: org.name,
            ownerId: org.ownerId,
            role: membership.role || "member",
            slug: org.slug,
        };
    });

    // Filter out null results (missing organizations)
    return results.filter((result): result is NonNullable<typeof result> => result !== null);
};

export type GenericCtx = ActionContext | MutationContext | QueryContext;

export type PublicCtx<Context extends MutationContext | QueryContext = QueryContext> = Context & {
    user: SessionUser | null;
};

/**
 * `builder.use(middleware)`, with the middleware built from a "produce the
 * extended context" function.
 *
 * Every factory below extends the context and hands it on, which Lunora spells
 * `builder.use(({ ctx, next }) => next({ ctx }))`. The builder type is returned
 * unchanged: these factories are exported, and letting `.use()`'s widened
 * context flow into their inferred return types makes those types reference
 * `@lunora/server` internals TypeScript cannot name from here (TS2883/TS4023).
 */
const withContext = <Builder extends { use: (middleware: never) => unknown }, ContextIn>(
    builder: Builder,
    produce: (context: ContextIn) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Builder =>
    builder.use(
        (async ({ ctx, next }: { ctx: ContextIn; next: (options: { ctx: Record<string, unknown> }) => Promise<unknown> }) =>
            await next({ ctx: await produce(ctx) })) as never,
    ) as Builder;

export type AuthCtx<Context extends MutationContext | QueryContext = QueryContext> = Context & {
    user: SessionUser;
};

export type AuthMutationCtx<Context extends MutationContext = MutationContext> = AuthCtx<Context>;

/** Options shared by the authenticated query factories. */
interface AuthQueryOptions {
    isDevelopmentOnly?: boolean;
    role?: "admin";
    shouldAllowAnonymous?: boolean;
}

/**
 * Factory function to create an authenticated query with user context.
 * Adds user and userId to the context, validates authentication, and optionally checks roles.
 * Supports Zod validators for type-safe arguments and returns.
 * @param options.shouldAllowAnonymous Whether to allow anonymous users (default: true)
 * @param options.isDevelopmentOnly Whether this query should only work in development (default: false)
 * @param options.role Optional role requirement (e.g., "admin")
 * @returns A query function with authentication and user context
 */
export const createAuthQuery = ({ isDevelopmentOnly, role, shouldAllowAnonymous = true }: AuthQueryOptions = {}) =>
    withContext(query, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Use getUserIdentity() for queries - faster performance
        const user = await getSessionUserWithAnonymousForQuery(context, shouldAllowAnonymous);
        const validatedUser = validateAuthUser(user, shouldAllowAnonymous, role);

        return {
            ...context,
            user: validatedUser,
        };
    });

/**
 * LIGHTWEIGHT auth factory for read-only queries (60-80% faster).
 *
 * Use this for queries that:
 * - Only need userId for data filtering
 * - Don't check ban status (read operations)
 * - Don't need org context or admin checks
 *
 * Saves 200-400ms per query by using JWT-only auth (zero DB reads).
 * Use regular createAuthQuery() for mutations or admin-level queries.
 */
export const createAuthQueryLite = ({
    isDevelopmentOnly,
    shouldAllowAnonymous = true,
}: {
    isDevelopmentOnly?: boolean;
    shouldAllowAnonymous?: boolean;
} = {}) =>
    withContext(query, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Use lightweight auth - JWT only, no DB lookups (imported at top)
        const user = await getSessionUserForQueryLite(context);

        if (!user && !shouldAllowAnonymous) {
            throw new LunoraError("UNAUTHORIZED", "Please sign in to continue");
        }

        return {
            ...context,
            user,
        };
    });

/**
 * Factory function to create an authenticated paginated query with user context.
 * Similar to createAuthQuery but returns paginated results.
 * @param options.shouldAllowAnonymous Whether to allow anonymous users (default: true)
 * @param options.isDevelopmentOnly Whether this query should only work in development (default: false)
 * @param options.role Optional role requirement (e.g., "admin")
 * @returns A paginated query function with authentication and user context
 */
export const createAuthPaginatedQuery = (options: AuthQueryOptions = {}) => createAuthQuery(options);

/**
 * Factory function to create a public query that optionally includes user context if authenticated.
 * Unlike createAuthQuery, this does not require authentication but will include user context if available.
 * Supports Zod validators for type-safe arguments and returns.
 * @param options.isDevelopmentOnly Whether this query should only work in development (default: false)
 * @param options.publicOnly Set to true when not depending on the session (default: false)
 * @param options.skipAuth Set to true to completely skip auth (fastest, for truly public queries)
 * @returns A query function with optional user context
 */
export const createPublicQuery = ({
    isDevelopmentOnly,
    publicOnly,
    skipAuth = false,
}: {
    isDevelopmentOnly?: boolean;
    /** Set to true when not depending on the session */
    publicOnly?: boolean;
    /** Set to true to completely skip auth overhead (saves 200-400ms) */
    skipAuth?: boolean;
} = {}) =>
    withContext(query, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // OPTIMIZATION: If skipAuth=true, skip all auth overhead (200-400ms savings)
        if (skipAuth) {
            return {
                ...context,
                user: null,
            };
        }

        // OPTIMIZATION: Use lightweight auth for public queries to avoid session lookup (saves 200ms)
        const user = publicOnly ? null : await getSessionUserForQueryLite(context);

        return {
            ...context,
            user,
        };
    });

export const createPublicPaginatedQuery = ({
    isDevelopmentOnly,
    publicOnly,
}: {
    isDevelopmentOnly?: boolean;
    /** Set to true when not depending on the session */
    publicOnly?: boolean;
} = {}) =>
    withContext(query, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Use getUserIdentity() for queries - faster performance
        const user = publicOnly ? null : await getSessionUserForQuery(context);

        return {
            ...context,
            user,
        };
    });

export const createInternalQuery = ({ isDevelopmentOnly }: { isDevelopmentOnly?: boolean } = {}) =>
    withContext(internalQuery, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Spread rather than returning `context` itself: Lunora's middleware
        // runner already merges via `{ ...ctx, ...next.ctx }`, so this is the
        // same value while satisfying `customCtx`'s `Record<string, unknown>`.
        return { ...context };
    });

/**
 * Factory function to create an authenticated internal query with user context.
 * Internal queries can only be called by other backend functions, not from the client.
 * Uses getUserIdentity() for better performance since this is a query (read operation).
 * @param options.isDevelopmentOnly Whether this query should only work in development (default: false)
 * @param options.role Optional role requirement (e.g., "admin")
 * @returns An internal query function with authentication and user context
 */
export const createAuthInternalQuery = ({
    isDevelopmentOnly,
    role,
}: {
    isDevelopmentOnly?: boolean;
    role?: "admin";
} = {}) =>
    withContext(internalQuery, async (context: QueryContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Use getSessionUserForQuery for internal queries - faster performance
        const user = requireUser(await getSessionUserForQuery(context));

        if (role) {
            roleGuard(role, user);
        }

        return { ...context, user };
    });

export const createAuthAction = ({
    isDevelopmentOnly,
    rateLimit,
    role,
}: {
    isDevelopmentOnly?: boolean;
    rateLimit?: RateLimitName | null;
    role?: "admin";
} = {}) =>
    withContext(action, async (context: ActionContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // For actions, get user via query
        const rawUser = await context.runQuery(api.auth.functions.getSessionUserQuery, {});

        const user = requireUser(rawUser as SessionUser | null);

        if (role) {
            roleGuard(role, user);
        }

        await applyRateLimit(context, rateLimit, user);

        return {
            ...context,
            user,
        };
    });

/**
 * Factory function to create a public action (no authentication required).
 * Actions can call external APIs and perform side effects.
 * @param options.isDevelopmentOnly Whether this action should only work in development (default: false)
 * @returns A public action function
 */
export const createPublicAction = ({ isDevelopmentOnly }: { isDevelopmentOnly?: boolean } = {}) =>
    withContext(action, async (context: ActionContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Spread rather than returning `context` itself: Lunora's middleware
        // runner already merges via `{ ...ctx, ...next.ctx }`, so this is the
        // same value while satisfying `customCtx`'s `Record<string, unknown>`.
        return { ...context };
    });

/**
 * Factory function to create an internal action (private, can only be called by other backend functions).
 * Internal actions can call external APIs and perform side effects.
 * @param options.isDevelopmentOnly Whether this action should only work in development (default: false)
 * @returns An internal action function
 */
export const createInternalAction = ({ isDevelopmentOnly }: { isDevelopmentOnly?: boolean } = {}) =>
    withContext(internalAction, async (context: ActionContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Spread rather than returning `context` itself: Lunora's middleware
        // runner already merges via `{ ...ctx, ...next.ctx }`, so this is the
        // same value while satisfying `customCtx`'s `Record<string, unknown>`.
        return { ...context };
    });

/**
 * Factory function to create an internal mutation (private, can only be called by other backend functions).
 * Internal mutations can modify the database but are not exposed to clients.
 * Supports Zod validators for type-safe arguments and returns.
 * @param options.isDevelopmentOnly Whether this mutation should only work in development (default: false)
 * @returns An internal mutation function
 */
export const createInternalMutation = ({ isDevelopmentOnly }: { isDevelopmentOnly?: boolean } = {}) =>
    withContext(internalMutation, async (context: MutationContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        // Spread rather than returning `context` itself: Lunora's middleware
        // runner already merges via `{ ...ctx, ...next.ctx }`, so this is the
        // same value while satisfying `customCtx`'s `Record<string, unknown>`.
        return { ...context };
    });

/**
 * Factory function to create an authenticated mutation with user context and rate limiting.
 * Mutations can modify the database. Includes rate limiting support.
 * Supports Zod validators for type-safe arguments and returns.
 * @param options.shouldAllowAnonymous Whether to allow anonymous users (default: true)
 * @param options.isDevelopmentOnly Whether this mutation should only work in development (default: false)
 * @param options.rateLimit Rate limit key for this mutation (optional)
 * @param options.role Optional role requirement (e.g., "admin")
 * @returns A mutation function with authentication, user context, and rate limiting
 */
export const createAuthMutation = ({
    isDevelopmentOnly,
    rateLimit,
    role,
    shouldAllowAnonymous = true,
}: {
    isDevelopmentOnly?: boolean;
    rateLimit?: RateLimitName | null;
    role?: "admin";
    shouldAllowAnonymous?: boolean;
} = {}) =>
    withContext(mutation, async (context: MutationContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        const user = await getSessionUserWithAnonymous(context, shouldAllowAnonymous);
        const validatedUser = validateAuthUser(user, shouldAllowAnonymous, role, MUTATION_AUTH_REQUIRED_ERROR);

        await applyRateLimit(context, rateLimit, validatedUser);

        return {
            ...context,
            user: validatedUser,
        };
    });

/**
 * Factory function to create a public mutation that optionally includes user context if authenticated.
 * Unlike createAuthMutation, this does not require authentication but will include user context if available.
 * Includes rate limiting support. Supports Zod validators for type-safe arguments and returns.
 * @param options.isDevelopmentOnly Whether this mutation should only work in development (default: false)
 * @param options.rateLimit Rate limit key for this mutation (optional)
 * @returns A mutation function with optional user context and rate limiting
 */
export const createPublicMutation = ({
    isDevelopmentOnly,
    rateLimit,
}: {
    isDevelopmentOnly?: boolean;
    rateLimit?: RateLimitName | null;
} = {}) =>
    withContext(mutation, async (context: MutationContext) => {
        checkDevelopmentOnly(isDevelopmentOnly);

        const user = await getSessionUserWriter(context);

        await applyRateLimit(context, rateLimit, user);

        return {
            ...context,
            user,
        };
    });

/**
 * These four are written out rather than assigned from the factories above.
 *
 * Lunora's codegen recognises a procedure only when the export's initializer IS a
 * builder chain — `export const x = query.input({})…`. An export assigned from a
 * factory call is silently skipped: it exists at runtime and never appears in
 * `_generated/api.ts`, so no client can address it. All four vanished, and the
 * only signal was `Property 'getUserSettings' does not exist` in `apps/web`, five
 * packages away. See anolilab/lunora#651 — closed with that resolution declared
 * out of scope, so this stays written out permanently. Codegen at least NAMES a
 * dropped export now (`WARN procedure_not_registered`), but it is a warning and
 * the build still exits 0.
 *
 * The factories stay — they are still the implementation. Only the registration
 * has to be syntactically visible.
 *
 * The same limit applies one level in, to `.input()`, and `updateUserSettings`
 * is still on the wrong side of it: `userSettingsFieldsWithoutUserId` is a
 * destructuring REST, not an object literal, and codegen resolves only a literal
 * or a `const` literal the chain names. So it generates
 * `FunctionReference<"mutation", {}, void>` — a public mutation whose arguments
 * nothing type-checks at the client boundary. `lunora codegen` reports it as
 * `WARN procedure_arguments_unreadable`; three others in `agent/` share the
 * shape via `omit(…)` calls. Spelling the fields out is the fix.
 */
export const updateUserSettings = authMutation
    .use(rateLimit("settings/update"))
    .input(userSettingsFieldsWithoutUserId)
    .mutation(async (options) => {
        const { ctx } = options;
        const result = await settingsUpsert("userSettings", options);

        ctx.log.event("auth.update_user_settings", { fieldCount: Object.keys(options.args).length });

        return result;
    });

export const getUserSettings = query.input({}).query(async (options) => await settingsGet("userSettings", options));

export const updateAIUserPreferences = authMutation
    .use(rateLimit("settings/update"))
    .input(aiUserPreferencesFields)
    .mutation(async (options) => {
        const { ctx } = options;
        const result = await settingsUpsert("aiUserPreferences", options);

        ctx.log.event("auth.update_ai_user_preferences", { fieldCount: Object.keys(options.args).length });

        return result;
    });

export const getAIUserPreferences = query.input({}).query(async (options) => await settingsGet("aiUserPreferences", options));

// Initialize user settings with timezone and location (called after registration)
export const initializeUserSettings = authMutation
    .use(rateLimit("settings/update"))
    .input({
        /** User's location, e.g. "New York, USA". */
        location: v.optional(v.string().max(MAX_LENGTH.short)),
        /** IANA timezone identifier from the browser. */
        timezone: v.string().max(MAX_LENGTH.short),
    })
    .output(v.null())
    .mutation(async ({ args: { location, timezone }, ctx: context }) => {
        const { userId } = context.user;

        const existingSettings = await context.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        const updates: { location?: string; timezone?: string } = {};

        if (existingSettings) {
            // If settings exist, update timezone and location if not set
            if (!existingSettings.timezone) {
                updates.timezone = timezone;
            }

            if (location && !existingSettings.location) {
                updates.location = location;
            }

            if (Object.keys(updates).length > 0) {
                await context.db.patch(existingSettings._id, withoutUndefined(updates));
            }
        } else {
            // Create new user settings with timezone and location
            await context.db.insert("userSettings", {
                timezone,
                userId,
                ...(location && { location }),
            });
        }

        context.log.event("auth.initialize_user_settings", { created: !existingSettings, hasLocation: Boolean(location) });

        return null;
    });

export const getUserPreferencesQuery = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            aboutMe: v.optional(v.string()),
            customInstructions: v.optional(v.string()),
            dictationLanguage: v.optional(v.string()),
            language: v.optional(v.string()),
            location: v.optional(v.string()),
            memoryEnabled: v.boolean(),
            nickname: v.optional(v.string()),
            profession: v.optional(v.string()),
            timezone: v.optional(v.string()),
        }),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const userSettings = await context.db
                .query("userSettings")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            return {
                aboutMe: userSettings?.aboutMe ?? undefined,
                customInstructions: userSettings?.customInstructions ?? undefined,
                dictationLanguage: userSettings?.dictationLanguage ?? undefined,
                language: userSettings?.language ?? undefined,
                location: userSettings?.location ?? undefined,
                memoryEnabled: userSettings?.memoryEnabled ?? false, // Opt-in; see memory/functions.ts#isMemoryEnabled
                nickname: userSettings?.nickname ?? undefined,
                profession: userSettings?.profession ?? undefined,
                timezone: userSettings?.timezone ?? undefined,
            };
        } catch {
            return {
                aboutMe: undefined,
                customInstructions: undefined,
                dictationLanguage: undefined,
                language: undefined,
                location: undefined,
                memoryEnabled: false,
                nickname: undefined,
                profession: undefined,
                timezone: undefined,
            };
        }
    });

export const getMCPServersQuery = internalQuery
    .input({ userId: v.string() })
    .output(
        v.array(
            v.object({
                enabled: v.boolean(),
                headers: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
                icon: v.optional(v.string()),
                name: v.string(),
                protocol: v.union(v.literal("sse"), v.literal("http")),
                url: v.string(),
            }),
        ),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const aiPreferences = await context.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            return aiPreferences?.mcpServers ?? [];
        } catch {
            return [];
        }
    });

export const getAgentModulePreferencesQuery = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            autoDetectComplexity: v.boolean(),
            autoMediaEnrichment: v.boolean(),
            enableDatasource: v.boolean(),
            enableKnowledge: v.boolean(),
            enablePlanner: v.boolean(),
            modelFilterRules: v.optional(
                v.object({
                    allowedModels: v.optional(v.array(v.string())),
                    allowedProviders: v.optional(v.array(v.string())),
                    allowedRegions: v.optional(v.array(v.string())),
                    blockedModels: v.optional(v.array(v.string())),
                    blockedProviders: v.optional(v.array(v.string())),
                    blockedRegions: v.optional(v.array(v.string())),
                    denyDataCollection: v.optional(v.boolean()),
                    requireZDR: v.optional(v.boolean()),
                }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const aiPreferences = await context.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            return {
                autoDetectComplexity: aiPreferences?.autoDetectComplexity ?? false,
                autoMediaEnrichment: (aiPreferences as { autoMediaEnrichment?: boolean } | null)?.autoMediaEnrichment ?? false,
                enableDatasource: aiPreferences?.enableDatasource ?? false,
                enableKnowledge: aiPreferences?.enableKnowledge ?? false,
                enablePlanner: aiPreferences?.enablePlanner ?? false,
                modelFilterRules: aiPreferences?.modelFilterRules ?? undefined,
            };
        } catch {
            return {
                autoDetectComplexity: false,
                autoMediaEnrichment: false,
                enableDatasource: false,
                enableKnowledge: false,
                enablePlanner: false,
                modelFilterRules: undefined,
            };
        }
    });

export const getDecryptedProviderKeysQuery = internalQuery
    .input({ userId: v.string() })
    .output(v.record(v.string(), v.string()))
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const prefs = await context.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            const raw = prefs?.providerApiKeys as Record<string, { enabled: boolean; encryptedKey: string }> | undefined;

            if (!raw) {
                return {};
            }

            const result: Record<string, string> = {};

            for (const [id, config] of Object.entries(raw)) {
                if (config.enabled && config.encryptedKey) {
                    result[id] = await decryptKey(config.encryptedKey, "provider-keys");
                }
            }

            if (Object.keys(result).length > 0) {
                console.info(`[BYOK Audit] userId=${userId} action=decrypt purpose=provider-keys keys=[${Object.keys(result).join(",")}]`);
            }

            return result;
        } catch {
            return {};
        }
    });

/**
 * Shape of one BYOK entry as stored inside the `v.any()` blobs on
 * `aiUserPreferences` (`generalProviders`, `messengerKeys`, `providerApiKeys`).
 * The schema cannot express it, so this is the single place it is written down.
 */
interface ByokKeyEntry {
    enabled?: boolean;
    encryptedKey?: string;
}

const TOOL_PROVIDER_IDS = ["tavily", "firecrawl", "brave", "serper", "supermemory"] as const;

type ToolProviderId = (typeof TOOL_PROVIDER_IDS)[number];

export const getDecryptedToolKeysQuery = internalQuery
    .input({ userId: v.string() })
    .output(v.record(v.string(), v.string()))
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const prefs = await context.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            // Genuine boundary: `aiUserPreferences.generalProviders` is `v.any()` in
            // the schema, so the Doc field is `unknown`. Narrow it to the named shape
            // we actually read rather than re-widening to `any`.
            const gp = prefs?.generalProviders as Partial<Record<ToolProviderId, ByokKeyEntry>> | undefined;

            if (!gp) {
                return {};
            }

            const out: Record<string, string> = {};

            for (const key of TOOL_PROVIDER_IDS) {
                const entry = gp[key];

                if (entry?.enabled && entry.encryptedKey) {
                    out[key] = await decryptKey(entry.encryptedKey, "tool-keys");
                }
            }

            if (Object.keys(out).length > 0) {
                console.info(`[BYOK Audit] userId=${userId} action=decrypt purpose=tool-keys keys=[${Object.keys(out).join(",")}]`);
            }

            return out;
        } catch {
            return {};
        }
    });

export const getDecryptedMessengerKeysQuery = internalQuery
    .input({ userId: v.string() })
    .output(v.record(v.string(), v.string()))
    .query(async ({ args: { userId }, ctx: context }) => {
        try {
            const prefs = await context.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .unique();

            // Genuine boundary: `messengerKeys` IS a column on `aiUserPreferences`,
            // but it is declared `v.any()`, so the Doc field is `unknown`. Narrowed to
            // the named entry shape instead of `any`.
            const raw = prefs?.messengerKeys as Record<string, ByokKeyEntry> | undefined;

            if (!raw) {
                return {};
            }

            const result: Record<string, string> = {};

            for (const [id, config] of Object.entries(raw)) {
                if (config.enabled && config.encryptedKey) {
                    result[id] = await decryptKey(config.encryptedKey, "messenger-keys");
                }
            }

            if (Object.keys(result).length > 0) {
                console.info(`[BYOK Audit] userId=${userId} action=decrypt purpose=messenger-keys keys=[${Object.keys(result).join(",")}]`);
            }

            return result;
        } catch {
            return {};
        }
    });

/**
 * The two user-row flags an HTTP route must not take from the JWT: `role`
 * (admin exemptions) and `isAnonymous` (guest model and quota). The identity
 * carries neither, so `getCurrentUserInternal` read them as absent and every
 * guest was treated as a free-tier user on `/chat/start`.
 */
export const getUserAuthFlagsQuery = internalQuery
    .input({ sessionId: v.optional(v.string()), userId: v.string() })
    .output(v.object({ isAnonymous: v.boolean(), plan: v.union(v.literal("premium"), v.null()), role: v.union(v.string(), v.null()) }))
    .query(async ({ args: { sessionId, userId }, ctx: context }) => {
        const user = await getUser(context, userId);
        // The user's own Pro, or the session's ACTIVE organization
        // (`auth/lib/plan.ts`), re-checked for membership like every other org context.
        const membership = sessionId
            ? await resolveActiveMembership(context, await context.db.session.findFirst({ where: { _id: sessionId as Id<"session"> } }), userId)
            : null;
        const plan = resolveUserPlan(user, membership ? [await getOrganization(context, membership.organizationId)] : []);

        return { isAnonymous: user?.isAnonymous === true, plan, role: user?.role ?? null };
    });

/**
 * The plan for a run with no session to read an active organization from —
 * a trigger, a workflow step, a group turn. Premium when ANY organization the
 * user belongs to is on a paid tier: the run acts for the user, not for one
 * of their organizations. Admins run any model.
 */
export const getUserRunPlanQuery = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ isAdmin: v.boolean(), plan: v.union(v.literal("premium"), v.null()) }))
    .query(async ({ args: { userId }, ctx: context }) => {
        const [user, memberships] = await Promise.all([getUser(context, userId), getMembersByUserId(context, userId)]);
        const organizations = await Promise.all(memberships.map(async (membership) => await getOrganization(context, membership.organizationId)));

        return {
            isAdmin: user?.role === "admin",
            plan: resolveUserPlan(user, organizations),
        };
    });

export const getActiveOrganizationQuery = internalQuery
    .input({ organizationId: v.string(), userId: v.string() })
    .output(
        v.union(
            v.object({
                id: v.string(),
                name: v.string(),
                role: v.string(),
                slug: v.union(v.string(), v.null()),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { organizationId, userId }, ctx: context }) => {
        try {
            // `Id<"organization">` rather than `as any`. With `any` the whole
            // returned object inferred as `any`, and because the generated
            // FunctionReference takes its Return from the HANDLER (never from
            // `.output()`), every caller of this query
            // received `unknown`. Typing the id types `org.name` / `org.slug` and
            // the reference along with them.
            const org = await context.db.organization.findFirst({ where: { _id: organizationId as Id<"organization"> } });

            if (!org) {
                return null;
            }

            const membership = await context.db.member.findFirst({ where: { organizationId, userId } });

            // A session keeps `activeOrganizationId` after the membership is gone
            // (see `resolveActiveMembership`), so no row means no org context — not
            // a default "member" role in an org the caller left.
            if (!membership) {
                return null;
            }

            return {
                id: org._id as string,
                name: org.name,
                role: membership.role,
                slug: org.slug ?? null,
            };
        } catch {
            return null;
        }
    });
