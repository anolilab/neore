/**
 * The one translation from a raw run error to what a user may read.
 *
 * Raw provider/gateway errors carry internal URLs, upstream status lines and
 * sometimes key fragments ("Gateway model proxy failed (502): Missing
 * Authentication header"), so they belong in logs only. Both places a failure
 * becomes visible go through here: the streamed error line (`failRun`) and the
 * `error` persisted on the failed assistant message (`agent/client/start.ts`),
 * so a reload shows the same text the stream did.
 */
import { isContextExceededError } from "./auto-continue";

export const USER_FACING_ERRORS = {
    authentication: "The AI provider rejected the request. Try again later, or pick another model.",
    contentBlocked: "This message was blocked by the content filter.",
    contextExceeded: "This conversation is too long for the selected model. Start a new thread or pick a model with a larger context window.",
    customEndpoint: "Your custom endpoint could not be reached or returned an error. Check its URL, API key and model in Settings → API Keys.",
    generic: "An error occurred while generating a response. Please try again.",
    notFound: "The requested resource was not found.",
    rateLimit: "Rate limit exceeded. Please try again later.",
    stopped: "Generation was stopped.",
    unavailable: "The AI provider is unavailable right now. Please try again in a moment.",
} as const;

/**
 * Our own run-lifecycle reasons. They name no infrastructure, and the pending
 * message they mark is superseded by a retry or a restart, so they pass as-is.
 */
const INTERNAL_REASONS = new Set(["Context exceeded — retrying with compression", "Context exceeded — retrying with compression...", "Restarting"]);

const KNOWN_MESSAGES = new Set<string>(Object.values(USER_FACING_ERRORS));

const CONTENT_BLOCKED_RE = /banned_content|inappropriate content|content[_ ]?(?:filter|policy)|safety system|flagged/i;
const RATE_LIMIT_RE = /\b429\b|rate[_ -]?limit|too many requests|quota/i;
const AUTHENTICATION_RE = /\b40[13]\b|api[_ -]?key|authenticat|unauthori[sz]ed|forbidden|credential/i;
const TIMEOUT_RE = /timeout|timed out/i;
const STOPPED_RE = /aborterror|\baborted\b|abortsignal|async abort/i;
const UNAVAILABLE_RE = /\b5\d\d\b|gateway|overloaded|unavailable|econn|fetch failed|network|not configured/i;
const NOT_FOUND_RE = /\b404\b|not found/i;

/** Message, status code and cause chain, flattened into one searchable string. */
const describe = (error: unknown, depth = 0): string => {
    if (error === null || error === undefined || depth > 4) {
        return "";
    }

    if (typeof error === "string") {
        return error;
    }

    if (typeof error !== "object") {
        return String(error);
    }

    const { cause, code, message, name, status, statusCode } = error as Record<string, unknown>;

    return [name, message, code, statusCode, status, describe(cause, depth + 1)]
        .filter((part) => part !== undefined && part !== null && part !== "")
        .map(String)
        .join(" ");
};

export interface UserFacingErrorOptions {
    /** The run used the user's own endpoint, whose failures are theirs to fix. */
    customEndpoint?: boolean;
}

/** Maps any run failure to a message from {@link USER_FACING_ERRORS}; never echoes raw error text. */
export const toUserFacingError = (error: unknown, options: UserFacingErrorOptions = {}): string => {
    const text = describe(error);

    if (KNOWN_MESSAGES.has(text) || INTERNAL_REASONS.has(text)) {
        return text;
    }

    // Our filter's verdict applies whoever's endpoint it was.
    if (CONTENT_BLOCKED_RE.test(text)) {
        return USER_FACING_ERRORS.contentBlocked;
    }

    // Before STOPPED: a timed-out fetch surfaces as "aborted due to timeout".
    if (TIMEOUT_RE.test(text)) {
        return options.customEndpoint ? USER_FACING_ERRORS.customEndpoint : USER_FACING_ERRORS.unavailable;
    }

    if (STOPPED_RE.test(text)) {
        return USER_FACING_ERRORS.stopped;
    }

    if (options.customEndpoint) {
        return USER_FACING_ERRORS.customEndpoint;
    }

    if (RATE_LIMIT_RE.test(text)) {
        return USER_FACING_ERRORS.rateLimit;
    }

    if (isContextExceededError(text)) {
        return USER_FACING_ERRORS.contextExceeded;
    }

    if (AUTHENTICATION_RE.test(text)) {
        return USER_FACING_ERRORS.authentication;
    }

    if (UNAVAILABLE_RE.test(text)) {
        return USER_FACING_ERRORS.unavailable;
    }

    if (NOT_FOUND_RE.test(text)) {
        return USER_FACING_ERRORS.notFound;
    }

    return USER_FACING_ERRORS.generic;
};
