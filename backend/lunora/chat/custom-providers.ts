/**
 * User-configured custom model endpoints (OpenAI-compatible: Ollama, LM Studio,
 * vLLM, …; or Anthropic-compatible Messages API servers).
 *
 * Rows live in `aiUserPreferences.customAIProviders[providerId]`, keyed by a
 * short slug, with the API key in the usual `{ enabled, encryptedKey }` BYOK
 * shape (purpose `custom-providers`). These procedures are the only writers —
 * the generic `updateAIUserPreferences` does not accept the column — because a
 * save also validates the URL and binds the stored key to it.
 *
 * Models are addressed as `custom:<providerId>/<modelId>` (see
 * `@neore/ai/models` `parseCustomModelId`). At chat time `chat/execute.ts`
 * resolves the row via `getDecryptedCustomProvider` and the gateway calls the
 * endpoint — which is why the endpoint must be publicly reachable: the backend
 * and gateway run on Cloudflare, not on the user's machine.
 *
 * The exception is the `local-browser` kind: a loopback Ollama / LM Studio the
 * user's BROWSER calls directly (`apps/web/src/features/local-models`). The
 * server stores its URL and model list and nothing else — no key, no tools —
 * never fetches it, and refuses to run it (`resolveRunModel`); the finished
 * turn comes back through `chat/local-models.ts:saveLocalTurn`.
 */
import { AZURE_DEFAULT_API_VERSION, isAwsAccessKeyId, isAzureApiVersion, validateNativeProviderKey } from "@neore/ai/gateway";
import { CUSTOM_PROVIDER_ID_RE } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "../_generated/server";
import { authAction, authMutation, authQuery, internalQuery, rateLimit } from "../lib/crpc";
import { lastFour } from "../auth/lib/byok-keys";
import { saveAiUserPreferences } from "../auth/lib/preference-writes";
import { decryptKey, encryptKey } from "../lib/encryption";
import { chatLogger } from "../lib/logger";
import {
    buildModelsRequestHeaders,
    buildModelsUrl,
    type CustomProviderModel,
    generateCustomProviderId,
    isLocalBrowserProvider,
    isNativeProvider,
    MAX_CUSTOM_MODELS_PER_PROVIDER,
    MAX_CUSTOM_PROVIDERS,
    parseGoogleModelsResponse,
    parseModelsResponse,
    PROBE_TIMEOUT_MS,
    type StoredCustomProvider,
    validateCustomEndpointUrl,
    validateEndpointUrlForType,
} from "./lib/custom-providers";

/** Bounded strings: the advisor flags unbounded args, and none of these has a reason to be long. */
const vBaseUrl = v.string().check((value) => value.length > 0 && value.length <= 2048, { message: "Invalid endpoint URL" });
const vApiKey = v.string().check((value) => value.length <= 4096, { message: "API key too long" });
const vProviderId = v.string().check((value) => value.length > 0 && value.length <= 40, { message: "Invalid endpoint id" });
/** Azure api-version, Bedrock region and access key id: short identifiers, validated in full by the handler. */
const vShortSetting = v.string().check((value) => value.length <= 64, { message: "Value too long" });

const vProviderType = v.union(
    v.literal("openai"),
    v.literal("anthropic"),
    v.literal("local-browser"),
    // Provider-native accounts on the user's own key (`isNativeProvider`).
    v.literal("google"),
    v.literal("azure"),
    v.literal("bedrock"),
    v.literal("mistral"),
);

const vModel = v.object({ id: v.string(), name: v.optional(v.string()) });

/** What the client sees: everything but the key, plus whether one is set. */
const vCustomProviderView = v.object({
    accessKeyId: v.optional(v.string()),
    apiVersion: v.optional(v.string()),
    baseUrl: v.string(),
    enabled: v.boolean(),
    hasApiKey: v.boolean(),
    id: v.string(),
    last4: v.optional(v.string()),
    models: v.array(vModel),
    name: v.string(),
    region: v.optional(v.string()),
    supportsTools: v.boolean(),
    type: vProviderType,
});

const vDecryptedCustomProvider = v.object({
    accessKeyId: v.optional(v.string()),
    apiKey: v.string(),
    apiVersion: v.optional(v.string()),
    baseUrl: v.string(),
    id: v.string(),
    models: v.array(vModel),
    region: v.optional(v.string()),
    supportsTools: v.boolean(),
    type: vProviderType,
});

const loadPreferences = async (ctx: MutationContext | QueryContext, userId: string) =>
    await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

/** `customAIProviders` is `v.any()` at rest; narrow it to the stored shape. */
const readProviders = (prefs: { customAIProviders?: unknown } | null): Record<string, StoredCustomProvider> => {
    const raw = prefs?.customAIProviders;

    return raw && typeof raw === "object" ? (raw as Record<string, StoredCustomProvider>) : {};
};

const sanitizeModels = (models: CustomProviderModel[]): CustomProviderModel[] => {
    const seen = new Set<string>();
    const out: CustomProviderModel[] = [];

    for (const model of models) {
        const id = model.id.trim();

        if (!id || id.length > 200 || seen.has(id)) {
            continue;
        }

        seen.add(id);

        const name = model.name?.trim().slice(0, 120);

        out.push(name ? { id, name } : { id });
    }

    if (out.length > MAX_CUSTOM_MODELS_PER_PROVIDER) {
        throw new LunoraError("BAD_REQUEST", `At most ${MAX_CUSTOM_MODELS_PER_PROVIDER} models per endpoint`);
    }

    return out;
};

/**
 * The per-provider settings a native account stores next to its key: Azure's
 * api-version, Bedrock's region and optional access key id. Validated here in
 * full because the gateway builds URLs and credentials from them.
 */
const resolveNativeSettings = (args: {
    accessKeyId?: string;
    apiVersion?: string;
    region?: string;
    type: string;
}): Pick<StoredCustomProvider, "accessKeyId" | "apiVersion" | "region"> => {
    if (args.type === "azure") {
        const apiVersion = args.apiVersion?.trim() || AZURE_DEFAULT_API_VERSION;

        if (!isAzureApiVersion(apiVersion)) {
            throw new LunoraError("BAD_REQUEST", "Enter an API version such as v1 or 2024-10-21");
        }

        return { apiVersion };
    }

    if (args.type === "bedrock") {
        // The region was already checked by `validateEndpointUrlForType`.
        const region = args.region?.trim() ?? "";
        const accessKeyId = args.accessKeyId?.trim() ?? "";

        if (accessKeyId && !isAwsAccessKeyId(accessKeyId)) {
            throw new LunoraError("BAD_REQUEST", "An access key id starts with AKIA and is 20 characters");
        }

        return accessKeyId ? { accessKeyId, region } : { region };
    }

    return {};
};

export const listCustomProviders = authQuery
    .input({})
    .output(v.array(vCustomProviderView))
    .query(async ({ ctx }) => {
        const providers = readProviders(await loadPreferences(ctx, ctx.user.userId));

        return Object.entries(providers)
            .map(([id, row]) => {
                return {
                    ...(row.accessKeyId && { accessKeyId: row.accessKeyId }),
                    ...(row.apiVersion && { apiVersion: row.apiVersion }),
                    baseUrl: row.endpoint,
                    enabled: row.enabled,
                    hasApiKey: Boolean(row.encryptedKey),
                    id,
                    ...(row.encryptedKey && row.last4 && { last4: row.last4 }),
                    models: row.models ?? [],
                    name: row.name,
                    ...(row.region && { region: row.region }),
                    supportsTools: row.supportsTools === true,
                    type: row.type ?? "openai",
                };
            })
            .toSorted((a, b) => a.name.localeCompare(b.name));
    });

export const saveCustomProvider = authMutation
    // Same save limit as every other BYOK key write.
    .use(rateLimit("byok/save"))
    .input({
        /** Bedrock: IAM access key id (the key is then its secret access key); `""` or omitted = a Bedrock API key. */
        accessKeyId: v.optional(vShortSetting),
        /** Omitted when `id` is set = keep the stored key; `""` = remove it. */
        apiKey: v.optional(vApiKey),
        /** Azure: api-version, default `v1`. */
        apiVersion: v.optional(vShortSetting),
        baseUrl: vBaseUrl,
        enabled: v.boolean(),
        /** Omit to create a new endpoint. */
        id: v.optional(vProviderId),
        models: v.array(vModel),
        name: v.string().check((value) => value.length <= 200, { message: "Name too long" }),
        /** Bedrock: AWS region; the runtime host is derived from it. */
        region: v.optional(vShortSetting),
        supportsTools: v.boolean(),
        type: vProviderType,
    })
    .output(v.object({ id: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const name = args.name.trim().slice(0, 60);

        if (!name) {
            throw new LunoraError("BAD_REQUEST", "Name is required");
        }

        const isLocal = isLocalBrowserProvider(args.type);
        const isNative = isNativeProvider(args.type);
        const checked = validateEndpointUrlForType(args.type, args.baseUrl, { region: args.region });

        if ("error" in checked) {
            throw new LunoraError("BAD_REQUEST", checked.error);
        }

        const native = isNative ? resolveNativeSettings(args) : {};

        // The browser calls a local endpoint, so a stored key would have to be
        // decrypted back to the browser — refuse one rather than hold it.
        if (isLocal && args.apiKey?.trim()) {
            throw new LunoraError("BAD_REQUEST", "Local endpoints take no API key");
        }

        const prefs = await loadPreferences(ctx, userId);
        const providers = readProviders(prefs);
        const existing = args.id ? providers[args.id] : undefined;

        if (args.id && (!existing || !CUSTOM_PROVIDER_ID_RE.test(args.id))) {
            throw new LunoraError("NOT_FOUND", "Custom endpoint not found");
        }

        if (!existing && Object.keys(providers).length >= MAX_CUSTOM_PROVIDERS) {
            throw new LunoraError("BAD_REQUEST", `At most ${MAX_CUSTOM_PROVIDERS} custom endpoints`);
        }

        // A stored key is only ever sent to the host it was saved for. Without
        // this, anyone holding the session could repoint the URL at their own
        // server and read the key off the next request.
        if (!isLocal && args.apiKey === undefined && existing?.encryptedKey && existing.endpoint !== checked.url) {
            throw new LunoraError("BAD_REQUEST", "Re-enter the API key when changing the endpoint URL");
        }

        // A Bedrock secret belongs to its access key id, and a stored key to its
        // provider: neither may silently carry over to a different one.
        if (args.apiKey === undefined && existing?.encryptedKey && (existing.accessKeyId ?? "") !== (native.accessKeyId ?? "")) {
            throw new LunoraError("BAD_REQUEST", "Re-enter the secret when changing the access key id");
        }

        if (args.apiKey === undefined && existing?.encryptedKey && existing.type !== args.type && (isNative || isNativeProvider(existing.type))) {
            throw new LunoraError("BAD_REQUEST", "Re-enter the API key when changing the provider");
        }

        if (isNative) {
            const typedKey = args.apiKey?.trim() ?? "";

            // A provider account without a key can do nothing; unlike a local
            // server, none of these accepts anonymous calls.
            if (typedKey === "" && (args.apiKey !== undefined || !existing?.encryptedKey)) {
                throw new LunoraError("BAD_REQUEST", "Enter the API key");
            }

            const keyProblem = typedKey ? validateNativeProviderKey(args.type as Parameters<typeof validateNativeProviderKey>[0], typedKey, native) : null;

            if (keyProblem) {
                throw new LunoraError("BAD_REQUEST", keyProblem);
            }
        }

        // Switching an endpoint to local drops any key it had.
        let encryptedKey = isLocal ? "" : (existing?.encryptedKey ?? "");
        let last4 = isLocal ? undefined : existing?.last4;

        if (args.apiKey !== undefined && !isLocal) {
            const key = args.apiKey.trim();

            encryptedKey = key ? await encryptKey(key, "custom-providers") : "";
            last4 = key ? lastFour(key) : undefined;
            console.info(`[BYOK Audit] userId=${userId} action=save purposes=[custom-providers]`);
        }

        const id = args.id ?? generateCustomProviderId(name, new Set(Object.keys(providers)));
        const now = ctx.now;
        const row: StoredCustomProvider = {
            ...native,
            createdAt: existing?.createdAt ?? now,
            enabled: args.enabled,
            encryptedKey,
            endpoint: checked.url,
            ...(last4 && { last4 }),
            models: sanitizeModels(args.models),
            name,
            // No tools run on the browser path (see `features/local-models`).
            supportsTools: isLocal ? false : args.supportsTools,
            type: args.type,
            updatedAt: now,
        };
        const customAIProviders = { ...providers, [id]: row };

        await saveAiUserPreferences(ctx.db, prefs, userId, { customAIProviders });

        ctx.log.event("chat.save_custom_provider", {
            created: existing === undefined,
            enabled: args.enabled,
            isLocal,
            isNative,
            modelCount: args.models.length,
            providerType: args.type,
            supportsTools: row.supportsTools,
        });

        return { id };
    });

export const deleteCustomProvider = authMutation
    .use(rateLimit("byok/save"))
    .input({ id: vProviderId })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const prefs = await loadPreferences(ctx, ctx.user.userId);
        const providers = readProviders(prefs);

        if (!prefs || !providers[args.id]) {
            return null;
        }

        const rest = Object.fromEntries(Object.entries(providers).filter(([id]) => id !== args.id));

        await saveAiUserPreferences(ctx.db, prefs, ctx.user.userId, { customAIProviders: rest });
        console.info(`[BYOK Audit] userId=${ctx.user.userId} action=delete purposes=[custom-providers]`);
        ctx.log.event("chat.delete_custom_provider", { remaining: Object.keys(rest).length });

        return null;
    });

/**
 * Decrypted provider for the chat path. `null` when the id is unknown or the
 * endpoint is disabled — the caller turns that into a user-facing error.
 */
export const getDecryptedCustomProvider = internalQuery
    .input({ providerId: v.string(), userId: v.string() })
    .output(v.union(vDecryptedCustomProvider, v.null()))
    .query(async ({ args: { providerId, userId }, ctx }) => {
        const row = readProviders(await loadPreferences(ctx, userId))[providerId];

        if (!row?.enabled) {
            return null;
        }

        const apiKey = row.encryptedKey ? await decryptKey(row.encryptedKey, "custom-providers") : "";

        if (apiKey) {
            console.info(`[BYOK Audit] userId=${userId} action=decrypt purpose=custom-providers keys=[${providerId}]`);
        }

        return {
            ...(row.accessKeyId && { accessKeyId: row.accessKeyId }),
            apiKey,
            ...(row.apiVersion && { apiVersion: row.apiVersion }),
            baseUrl: row.endpoint,
            id: providerId,
            models: row.models ?? [],
            ...(row.region && { region: row.region }),
            supportsTools: row.supportsTools === true,
            type: row.type ?? "openai",
        };
    });

/**
 * `GET {baseUrl}/models` against a user endpoint — backs both "Test
 * connection" and "Fetch models". An ACTION, because it is an outbound fetch:
 * bounded by `AbortSignal.timeout`, never follows a redirect (a 30x could point
 * at a host the SSRF guard refused), and cancels every body it does not read.
 *
 * `apiKey` omitted with an `id` = use the stored key, so the key never has to
 * travel back to the browser to test a saved endpoint.
 */
export const probeCustomProvider = authAction
    .use(rateLimit("byok/decrypt"))
    .input({
        apiKey: v.optional(vApiKey),
        /** Azure: the api-version to test with. */
        apiVersion: v.optional(vShortSetting),
        baseUrl: vBaseUrl,
        id: v.optional(vProviderId),
        type: vProviderType,
    })
    .output(v.union(v.object({ latencyMs: v.number(), models: v.array(vModel), ok: v.literal(true) }), v.object({ error: v.string(), ok: v.literal(false) })))
    .action(async ({ args, ctx }) => {
        // The server cannot reach the user's machine; the web app probes it.
        if (isLocalBrowserProvider(args.type)) {
            return { error: "Local endpoints are tested from your browser", ok: false as const };
        }

        // Bedrock signs every request (SigV4) or takes a bearer key on the
        // runtime host only; there is no cheap unsigned list call to test with.
        if (args.type === "bedrock") {
            return { error: "Bedrock credentials are checked on the first chat — there is no connection test", ok: false as const };
        }

        // Native kinds are pinned to their provider's host; the rest must be public https.
        const checked = isNativeProvider(args.type) ? validateEndpointUrlForType(args.type, args.baseUrl) : validateCustomEndpointUrl(args.baseUrl);

        if ("error" in checked) {
            return { error: checked.error, ok: false as const };
        }

        let { apiKey } = args;

        if (apiKey === undefined && args.id) {
            const stored = await ctx.runQuery(internal.chat.custom_providers.getDecryptedCustomProvider, { providerId: args.id, userId: ctx.user.userId });

            // The stored key goes only to the URL it was saved for (see saveCustomProvider).
            if (stored?.apiKey && stored.baseUrl !== checked.url) {
                return { error: "Re-enter the API key to test a different URL", ok: false as const };
            }

            apiKey = stored?.apiKey;
        }

        const started = Date.now();
        let response: Response;

        try {
            response = await fetch(buildModelsUrl(args.type, checked.url, { apiVersion: args.apiVersion }), {
                headers: buildModelsRequestHeaders(args.type, apiKey?.trim() || undefined),
                method: "GET",
                redirect: "manual",
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
        } catch (error) {
            const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

            return { error: isTimeout ? `No response within ${PROBE_TIMEOUT_MS / 1000}s` : "Could not connect to the endpoint", ok: false as const };
        }

        if (!response.ok) {
            // A Worker must consume or cancel every body it opens (CLAUDE.md: an
            // unconsumed body on a failed fetch can take the local runtime down).
            await response.body?.cancel();

            if (response.status >= 300 && response.status < 400) {
                return { error: "The endpoint answered with a redirect; use the final URL", ok: false as const };
            }

            if (response.status === 401 || response.status === 403) {
                return { error: `Authentication failed (HTTP ${response.status}) — check the API key`, ok: false as const };
            }

            return { error: `The endpoint answered HTTP ${response.status}`, ok: false as const };
        }

        let body: unknown;

        try {
            body = await response.json();
        } catch {
            const hint = args.type === "anthropic" ? "the server root, without /v1/messages" : "usually ending in /v1";

            return { error: `The endpoint did not return JSON — is the base URL right (${hint})?`, ok: false as const };
        }

        // Azure's list is base models, not the user's deployments — a key check only.
        let models: CustomProviderModel[];

        if (args.type === "azure") {
            models = [];
        } else if (args.type === "google") {
            models = parseGoogleModelsResponse(body);
        } else {
            models = parseModelsResponse(body);
        }

        chatLogger.info(`[CustomProvider] probe ok userId=${ctx.user.userId} models=${models.length}`);
        ctx.log.event("chat.probe_custom_provider", { modelCount: models.length, providerType: args.type });

        return { latencyMs: Date.now() - started, models, ok: true as const };
    });
