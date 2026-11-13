/** What the CLI approval page tells the person when a lookup, approval or denial fails. */
export type DeviceProblem = "deviceLimit" | "expired" | "impersonating" | "invalid" | "keyLimit" | "rateLimited" | "unavailable";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The OAuth-style code of a failed request. The client's error is the response body plus `status`, so the code
 * is its `error` string; a body wrapped one level deeper (`error: { error }`) is read the same way.
 */
const codeOf = (failure: unknown): string | undefined => {
    if (!isRecord(failure)) {
        return undefined;
    }

    const { error } = failure;

    if (typeof error === "string") {
        return error;
    }

    return isRecord(error) && typeof error["error"] === "string" ? error["error"] : undefined;
};

const statusOf = (failure: unknown): number | undefined => (isRecord(failure) && typeof failure["status"] === "number" ? failure["status"] : undefined);

/** Terminal failures say why a new code or a revoked key is needed; anything else is a retryable "unavailable". */
export const problemOf = (failure: unknown): DeviceProblem => {
    const code = codeOf(failure);
    const status = statusOf(failure);

    // The limiter answers 429 with a plain message, not an OAuth code.
    if (status === 429) {
        return "rateLimited";
    }

    // An admin session acting as someone else is refused on open, approve and deny. The page already
    // handles guests before it asks, so this 403 reads as the impersonation refusal.
    if (status === 403 && code === "access_denied") {
        return "impersonating";
    }

    if (code === "expired_token") {
        return "expired";
    }

    if (code === "device_limit") {
        return "deviceLimit";
    }

    if (code === "key_limit") {
        return "keyLimit";
    }

    return code === "invalid_request" || code === "invalid_grant" ? "invalid" : "unavailable";
};
