/**
 * The `requestSecret` tool's name, limits and types (`request-secret.ts`), apart
 * from the tools themselves so the run, claim and procedure code can import them
 * without loading the agent client.
 */
export const REQUEST_SECRET_TOOL_NAME = "requestSecret";

export const SAVE_SECRET_AS_PROVIDER_KEY_TOOL_NAME = "saveSecretAsProviderKey";

export const SET_MCP_SERVER_SECRET_TOOL_NAME = "setMcpServerSecret";

export const SECRET_LABEL_MAX = 120;

export const SECRET_PURPOSE_MAX = 300;

export const SECRET_SERVER_NAME_MAX = 200;

export const SECRET_HEADER_NAME_MAX = 100;

/** A provider key is capped like the settings page caps one (`MAX_LENGTH.short`); a header value like a stored MCP header (`MAX_LENGTH.long`). */
export const SECRET_PROVIDER_KEY_MAX = 500;

export const SECRET_HEADER_VALUE_MAX = 10_000;

/** How long a saved value waits for the agent to use it. */
export const SECRET_TTL_MS = 24 * 60 * 60 * 1000;

/** The longest ref a consumer accepts; a ref is `sec_` plus 32 base64url characters. */
export const SECRET_REF_MAX = 64;

/** The providers the settings page takes a key for (`api-keys-settings.tsx`'s `AI_PROVIDERS`). */
export const SECRET_PROVIDERS = ["openrouter", "groq", "xai", "requesty", "anthropic", "openai"] as const;

/** An HTTP header field name (RFC 9110 token). */
export const SECRET_HEADER_NAME_RE = /^[\w!#$%&'*+.^`|~-]+$/u;

/** What the model is told when the user declines to give the secret. */
export const SECRET_DECLINED_REASON =
    "The user declined to provide the secret. Do not ask again unless they bring it up; continue without it or suggest they add it in Settings.";

export type SecretUse = { header: string; kind: "mcp_header"; server: string } | { kind: "provider_key"; provider: string };

export interface RequestSecretInput {
    label: string;
    purpose?: string;
    use: SecretUse;
}

/** What the model reads: a reference and a status, never the value. */
export type RequestSecretOutput = { message: string; status: "unavailable" } | { ref: string; status: "saved" };

/** Why a reference could not be used. */
export type SecretFailure = "destination_missing" | "expired" | "not_found" | "unreadable" | "used" | "wrong_use";

export const SECRET_FAILURE_MESSAGES: Record<SecretFailure, string> = {
    destination_missing: "The destination the user approved no longer exists. Tell the user; the reference is still valid for 24 hours.",
    expired: "That reference has expired. Ask the user again with requestSecret.",
    not_found: "No such reference. Ask the user with requestSecret.",
    unreadable: "The stored value could not be read. Ask the user again with requestSecret.",
    used: "That reference was already used. Ask the user again with requestSecret.",
    wrong_use: "That reference was requested for a different destination.",
};
