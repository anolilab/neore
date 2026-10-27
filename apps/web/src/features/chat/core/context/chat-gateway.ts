import env from "@/lib/env";
import { RateLimitError } from "@/lib/errors";

/** Chat stream endpoint — all requests go through the LLM Gateway */
export const CHAT_STREAM_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat`;

/** Chat edit endpoint — message edits go through the LLM Gateway */
export const CHAT_EDIT_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat/edit`;

/**
 * A gateway error body. Most failures are `{ error, message }`; a rate limit is
 * `{ error: { code, message, retryAfter } }` (seconds), so both shapes are read.
 */
export interface GatewayErrorBody {
    bannedWords?: string[];
    error?: string | { code?: string; message?: string; retryAfter?: number };
    message?: string;
}

/** The error for a failed gateway response. A 429 is a `RateLimitError`, so the chat shows the limit, not a server error. */
export const gatewayError = (status: number, body: GatewayErrorBody): Error => {
    const nested = typeof body.error === "object" ? body.error : undefined;
    const message = body.message || nested?.message || (typeof body.error === "string" ? body.error : "") || `HTTP ${status}`;

    return status === 429 ? new RateLimitError(message, (nested?.retryAfter ?? 60) * 1000) : new Error(message);
};

export interface GatewayInfo {
    gatewayUrl: string | null;
    /** The stream `/v1/chat` just started — known before the live `getActiveStreamForThread` reports it. */
    streamId: string | null;
    streamToken: string | null;
}

export const NO_GATEWAY_INFO: GatewayInfo = { gatewayUrl: null, streamId: null, streamToken: null };

/**
 * Hands a new thread's stream credentials across the `/chat` → `/chat/$threadId`
 * navigation. Those are two routes, so the provider that started the stream
 * unmounts and the one that must render it mounts with empty state; without
 * this the new thread never opened `/v1/stream` and sat on "stop generating"
 * with no reply. Module scope, not history state, so the bearer-equivalent
 * token is never persisted; the receiving provider drops its entry on mount.
 */
export const pendingGatewayInfo = new Map<string, GatewayInfo>();

/**
 * Trusted gateway origin used to validate any server-supplied `gatewayUrl`
 *  before opening an SSE/NDJSON stream. Prevents a compromised upstream from
 *  redirecting clients (and the bearer-equivalent stream token) to an
 *  attacker-controlled host.
 */
const TRUSTED_GATEWAY_ORIGIN = (() => {
    try {
        return new URL(env.VITE_LLM_GATEWAY_URL).origin;
    } catch {
        return null;
    }
})();

const withoutTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

/**
 * The fallback is the configured gateway BASE URL, not its bare origin: in dev
 * the gateway sits behind the app's `/llm-gateway` proxy, so the origin alone
 * points `/v1/stream` at the app itself and the stream never opens.
 */
const TRUSTED_GATEWAY_BASE = TRUSTED_GATEWAY_ORIGIN ? withoutTrailingSlashes(env.VITE_LLM_GATEWAY_URL) : null;

export const validateGatewayUrl = (candidate: string | null | undefined): string | null => {
    if (!candidate || !TRUSTED_GATEWAY_ORIGIN) return TRUSTED_GATEWAY_BASE;

    try {
        return new URL(candidate).origin === TRUSTED_GATEWAY_ORIGIN ? candidate : TRUSTED_GATEWAY_BASE;
    } catch {
        return TRUSTED_GATEWAY_BASE;
    }
};
