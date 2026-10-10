/**
 * Scoped API keys for the public v1 API.
 *
 * Listing and revoking go through better-auth's own client endpoints
 * (`/api-key/list`, `/api-key/delete`), which the settings UI already uses.
 * Creation cannot: `permissions` is a SERVER-ONLY field of `/api-key/create`,
 * so a key with scopes has to be minted here, server-side, on the caller's
 * behalf. The `apikey` table behind this plugin is the only key store (the
 * older `saasApiKeys` table was removed).
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { getAuth } from "../auth";
import { authAction, internalQuery, rateLimit } from "../lib/crpc";
import type { ApiKeyAuthApi } from "../public-api/identity";
import { readApiKeyIdentity } from "../public-api/identity";
import { API_RESOURCES, scopesFromStrings, scopesToStrings } from "../public-api/scopes";
import { MAX_LENGTH } from "../lib/validators";

/** Enough for one key per machine/integration; a runaway script cannot fill the table. */
export const MAX_API_KEYS_PER_USER = 25;

const MAX_NAME_LENGTH = 32;

const DAY_SECONDS = 24 * 60 * 60;

/** The expiries the settings dialog offers; anything else is refused. `null` = never. */
export const ALLOWED_EXPIRY_DAYS: ReadonlyArray<number> = [7, 30, 90, 180, 365];

/** What key creation needs to know about the caller, in one read. */
export const getApiKeyCreationState = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ existingKeys: v.number(), isAnonymous: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const [{ page }, user] = await Promise.all([
            ctx.db.apikey.findMany({ limit: MAX_API_KEYS_PER_USER + 1, where: { referenceId: args.userId } }),
            ctx.db.user.findFirst({ where: { _id: ctx.db.asId("user", args.userId) } }),
        ]);

        return { existingKeys: page.length, isAnonymous: user?.isAnonymous === true };
    });

export const createScopedApiKey = authAction
    .use(rateLimit("apiKeys/create"))
    .input({
        expiresInDays: v.optional(v.union(v.number(), v.null())),
        name: v.string().max(MAX_LENGTH.short),
        scopes: v.array(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            expiresAt: v.union(v.number(), v.null()),
            id: v.string(),
            key: v.string(),
            name: v.string(),
            scopes: v.array(v.string()),
            start: v.union(v.string(), v.null()),
        }),
    )
    .action(async ({ args, ctx }) => {
        // A key must never mint a key. The RPC surface does not accept API keys
        // today (`public-api/identity.ts`); this holds if that ever changes.
        if (readApiKeyIdentity(await ctx.auth.getIdentity(), ctx.auth.userId)) {
            throw new LunoraError("FORBIDDEN", "API keys cannot create API keys");
        }

        const name = args.name.trim();

        if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `Name must be 1-${String(MAX_NAME_LENGTH)} characters`);
        }

        const scopes = scopesFromStrings(args.scopes);

        if (!scopes || Object.keys(scopes).length === 0) {
            throw new LunoraError("BAD_REQUEST", `Choose at least one valid scope (<resource>:<read|write>, resources: ${API_RESOURCES.join(", ")})`);
        }

        const expiresInDays = args.expiresInDays ?? null;

        if (expiresInDays !== null && !ALLOWED_EXPIRY_DAYS.includes(expiresInDays)) {
            throw new LunoraError("BAD_REQUEST", `Expiry must be one of ${ALLOWED_EXPIRY_DAYS.join(", ")} days, or none`);
        }

        const state = await ctx.runQuery(internal.auth.api_keys.getApiKeyCreationState, { userId: ctx.user.userId });

        // A guest session is disposable and uninvited (see "INVITE-ONLY
        // REGISTRATION" in CLAUDE.md); a long-lived credential for it would
        // outlive both properties.
        if (state.isAnonymous) {
            throw new LunoraError("FORBIDDEN", "Create an account to use API keys");
        }

        if (state.existingKeys >= MAX_API_KEYS_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can have at most ${String(MAX_API_KEYS_PER_USER)} API keys. Revoke one first.`);
        }

        const created = await (getAuth().api as unknown as ApiKeyAuthApi).createApiKey({
            body: {
                name,
                permissions: scopes as Record<string, string[]>,
                userId: ctx.user.userId,
                ...(expiresInDays !== null && { expiresIn: expiresInDays * DAY_SECONDS }),
            },
        });

        const expiresAt = created.expiresAt ? new Date(created.expiresAt).getTime() : null;

        ctx.log.event("api_keys.create_scoped_api_key", {
            apiKeyId: created.id,
            hasExpiry: expiresInDays !== null,
            scopeCount: Object.keys(scopes).length,
        });

        return {
            expiresAt,
            id: created.id,
            key: created.key,
            name: created.name ?? name,
            scopes: scopesToStrings(scopes),
            start: created.start ?? null,
        };
    });
