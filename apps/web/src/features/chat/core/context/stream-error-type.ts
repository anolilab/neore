import { AppError } from "@/lib/errors";

/**
 * A send failure's category for `stream_error.error_type`: the app error's code, else the error's name. Never its
 * message: a gateway's message can carry the person's text, and an event tracked before PostHog starts is kept in the
 * tab's storage (`lib/analytics/posthog-client.ts#queueEvent`).
 */
export const streamErrorType = (error: unknown): string => {
    if (error instanceof AppError) {
        return error.code;
    }

    return error instanceof Error ? error.name : "unknown";
};
