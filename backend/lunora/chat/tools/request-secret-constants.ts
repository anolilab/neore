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

/** How long a saved value waits for the agent to use it, at most: it is also dropped when the reply that received it ends. */
export const SECRET_TTL_MS = 24 * 60 * 60 * 1000;

/** The longest ref a consumer accepts; a ref is `sec_` plus 32 base64url characters. */
export const SECRET_REF_MAX = 64;

/** The providers the settings page takes a key for (`api-keys-settings.tsx`'s `AI_PROVIDERS`). */
export const SECRET_PROVIDERS = ["openrouter", "groq", "xai", "requesty", "anthropic", "openai"] as const;

/** An HTTP header field name (RFC 9110 token). */
export const SECRET_HEADER_NAME_RE = /^[\w!#$%&'*+.^`|~-]+$/u;

/** Headers the transport owns: a secret must not set them (they would redirect the request, smuggle a cookie or break its framing). */
const FORBIDDEN_HEADERS = new Set(["connection", "content-length", "cookie", "host", "transfer-encoding", "upgrade"]);

/** Whether `name` is a header the transport owns — `Host`, `Cookie`, `Connection`, `Transfer-Encoding`, `Content-Length`, `Upgrade` and every `Proxy-*`. */
export const isForbiddenSecretHeader = (name: string): boolean => {
    const lower = name.toLowerCase();

    return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-");
};

/** A header value that could end the header and start another (CR, LF), that no server accepts (NUL), or that is not a ByteString (above U+00FF, which the `Headers` constructor throws on). */
export const SECRET_HEADER_VALUE_FORBIDDEN_RE = /[\0\n\r\u{100}-\u{10FFFF}]/u;

/** What the model is told when the user declines to give the secret. */
export const SECRET_DECLINED_REASON =
    "The user declined to provide the secret. Do not ask again unless they bring it up; continue without it or suggest they add it in Settings.";

/**
 * Where a secret goes. A header's `url` is not part of the model's call: it is the address of the named server
 * when the user answered, recorded so the value goes to that server and not to another that took the name later.
 */
export type SecretUse = { header: string; kind: "mcp_header"; server: string; url?: string } | { kind: "provider_key"; provider: string };

export interface RequestSecretInput {
    label: string;
    purpose?: string;
    use: SecretUse;
}

/** What the model reads: a reference and a status, never the value. */
export type RequestSecretOutput = { message: string; status: "unavailable" } | { ref: string; status: "saved" };

/** Why a reference could not be used. */
export type SecretFailure = "destination_missing" | "expired" | "not_found" | "unreadable" | "used" | "wrong_run" | "wrong_use";

export const SECRET_FAILURE_MESSAGES: Record<SecretFailure, string> = {
    destination_missing:
        "The destination the user approved no longer exists as they approved it. Tell the user; the reference stays valid until this reply ends.",
    expired: "That reference has expired. Ask the user again with requestSecret.",
    not_found: "No such reference. Ask the user with requestSecret.",
    unreadable: "The stored value could not be read. Ask the user again with requestSecret.",
    used: "That reference was already used, or its reply has ended. Ask the user again with requestSecret.",
    wrong_run: "That reference can only be used in a reply the owner of the chat started. Ask the owner.",
    wrong_use: "That reference was requested for a different destination.",
};

/** `error.data.code` of the refusal when the saved MCP server's address is no longer the one the card showed; the card words it and reloads the address. */
export const SECRET_SERVER_MOVED = "SECRET_SERVER_MOVED";
