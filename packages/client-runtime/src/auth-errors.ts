import { isUnauthorizedError } from "@lunora/react";

const UNAUTHORIZED_MESSAGE_RE = /UNAUTHORIZED|please sign in/i;

/**
 * Determines whether an error is auth related (UNAUTHORIZED / 401).
 */
export const isAuthError = (error: unknown): boolean => {
    if (!error) {
        return false;
    }

    // Fast path: Lunora error with UNAUTHORIZED code (most common case)
    if (isUnauthorizedError(error)) {
        return true;
    }

    // Generic object with .code property (covers LunoraError.data.code, plain objects)
    if (typeof error === "object" && error !== null) {
        if ("data" in error) {
            const { data } = error as { data: unknown };

            if (data && typeof data === "object" && "code" in data && (data as { code: unknown }).code === "UNAUTHORIZED") {
                return true;
            }
        }

        if ("code" in error && (error as { code: unknown }).code === "UNAUTHORIZED") {
            return true;
        }
    }

    // Message fallback for edge cases
    const message = error instanceof Error ? error.message : "";

    return UNAUTHORIZED_MESSAGE_RE.test(message);
};
