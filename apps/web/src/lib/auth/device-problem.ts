/** What the CLI approval page tells the person when a lookup, approval or denial fails. */
export type DeviceProblem = "expired" | "invalid" | "keyLimit" | "notAllowed" | "unavailable";

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

/** Terminal failures say why a new code or a revoked key is needed; anything else is a retryable "unavailable". */
export const problemOf = (failure: unknown): DeviceProblem => {
    const code = codeOf(failure);

    if (code === "expired_token") {
        return "expired";
    }

    if (code === "key_limit") {
        return "keyLimit";
    }

    // The session may not use a code at all (a guest, or an admin impersonating): trying again cannot work.
    if (code === "access_denied") {
        return "notAllowed";
    }

    return code === "invalid_request" || code === "invalid_grant" ? "invalid" : "unavailable";
};

/** Only a failure that may pass by itself offers "Try again"; a refused session or a spent code never does. */
export const canRetry = (problem: DeviceProblem): boolean => problem === "unavailable";
