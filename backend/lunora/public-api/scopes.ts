/**
 * API key scopes for the public v1 API.
 *
 * A key's scopes are stored in better-auth's `apikey.permissions` column as the
 * plugin's own `{ resource: action[] }` statement shape, so the plugin can check
 * them too. This module is the ONE list of resources and actions: the key
 * creation procedure validates against it, the router checks every route against
 * it, the OpenAPI spec documents it and the settings UI renders it.
 *
 * `write` does not imply `read` — a key asked for `threads:write` only can
 * delete a thread but not list them. That keeps a leaked write-only key (a CI
 * job that only posts) from exfiltrating anything.
 */

export const API_RESOURCES = ["chat", "threads", "skills", "tasks", "knowledge", "memories", "models"] as const;

export type ApiResource = (typeof API_RESOURCES)[number];

export const API_ACTIONS = ["read", "write"] as const;

export type ApiAction = (typeof API_ACTIONS)[number];

/** better-auth's permission statement: resource → allowed actions. */
export type ApiScopes = Partial<Record<ApiResource, ApiAction[]>>;

/**
 * What a key gets when it is created without scopes (the plugin's
 * `defaultPermissions`): read-only on everything. Never write — a key minted by
 * a client that predates scopes must not be able to delete data.
 */
export const DEFAULT_API_SCOPES: ApiScopes = Object.fromEntries(API_RESOURCES.map((resource) => [resource, ["read"]])) as ApiScopes;

const isResource = (value: string): value is ApiResource => (API_RESOURCES as ReadonlyArray<string>).includes(value);

const isAction = (value: unknown): value is ApiAction => typeof value === "string" && (API_ACTIONS as ReadonlyArray<string>).includes(value);

/**
 * Normalise whatever the key row carries into a clean scope map.
 *
 * Unknown resources and actions are DROPPED, not rejected: the column is
 * shared with better-auth and an unrecognised entry must never widen access.
 * A string is parsed (the column is JSON text when read raw).
 */
export const parseScopes = (raw: unknown): ApiScopes => {
    let value = raw;

    if (typeof value === "string") {
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return {};
        }
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    const scopes: ApiScopes = {};

    for (const [resource, actions] of Object.entries(value as Record<string, unknown>)) {
        if (!isResource(resource) || !Array.isArray(actions)) {
            continue;
        }

        const valid = [...new Set(actions.filter((action) => isAction(action)))];

        if (valid.length > 0) {
            scopes[resource] = valid;
        }
    }

    return scopes;
};

export const hasScope = (scopes: ApiScopes, resource: ApiResource, action: ApiAction): boolean => scopes[resource]?.includes(action) ?? false;

/** `threads:read` style strings, for error messages, the CLI and the OpenAPI spec. */
export const formatScope = (resource: ApiResource, action: ApiAction): string => `${resource}:${action}`;

/**
 * Parse `["threads:read", "chat:write"]` into a scope map. Returns `null` when
 * any entry is malformed, so a typo is an error rather than a silently narrower key.
 */
export const scopesFromStrings = (entries: ReadonlyArray<string>): ApiScopes | null => {
    const scopes: ApiScopes = {};

    for (const entry of entries) {
        const [resource, action, extra] = entry.split(":", 3);

        if (extra !== undefined || !resource || !isResource(resource) || !isAction(action)) {
            return null;
        }

        const current = scopes[resource] ?? [];

        if (!current.includes(action)) {
            scopes[resource] = [...current, action];
        }
    }

    return scopes;
};

export const scopesToStrings = (scopes: ApiScopes): string[] =>
    API_RESOURCES.flatMap((resource) => (scopes[resource] ?? []).map((action) => formatScope(resource, action)));
