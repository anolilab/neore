/**
 * The rate limit behind a provider rejection, as structured data.
 *
 * The backend pauses a run on a rate limit and resumes it at the provider's own
 * retry time. It must not read that off message text, so the gateway — which sees
 * the provider's headers and body — extracts `{ status, retryAt }` here and sends
 * it next to `fallbackReason` (`routes/internal/model-proxy.ts`).
 *
 * Sources, in order: `retry-after-ms`, `retry-after` (seconds or an HTTP date),
 * the body (Google's `RetryInfo.retryDelay`, OpenRouter's relayed `X-RateLimit-Reset`,
 * then the wait an OpenAI-style message states), and last the reset headers of an
 * exhausted limit (OpenAI and Groq durations, Anthropic RFC 3339).
 */

export interface RateLimitInfo {
    /** Epoch ms the provider says to retry at. Absent when it said nothing: the backend picks a default. */
    retryAt?: number;
    /** The provider's HTTP status (429, or a 5xx that carried a retry time). */
    status: number;
}

/** Stands in for a retry time that is no number: further out than any pause the backend allows. */
const NEVER_AT = Number.MAX_SAFE_INTEGER;

/** A parsed JSON body or an error object: read field by field, never trusted whole. */
interface Loose {
    [key: string]: unknown;
}

/** Structured error codes and names that mean "throttled" on a response that carries no status. */
const THROTTLE_CODES: ReadonlySet<string> = new Set([
    "rate_limit_error",
    "rate_limit_exceeded",
    "resource_exhausted",
    "throttlingexception",
    "too_many_requests",
    "toomanyrequestsexception",
]);

const DURATION_PART = /([\d.]{1,12})(ms|[hms])/g;
const UNIT_MS = new Map([
    ["h", 3_600_000],
    ["m", 60_000],
    ["ms", 1],
    ["s", 1000],
]);
/** "Please try again in 7.66s", "Please retry in 34.5s", "try again in 820ms", "try again in 7m12s". */
const MESSAGE_WAIT = /(?:try again|retry) in ([\d.hms]+)/i;
const TRAILING_DOT = /\.$/;
const RESET_REMAINING = /-reset$/;
/** Epoch values below this are seconds, above it milliseconds. */
const EPOCH_MS_FLOOR = 1e11;

/** `"6m0s"`, `"1.5s"`, `"20ms"` as milliseconds; `undefined` for anything else. */
export const parseDuration = (text: string): number | undefined => {
    const parts = text.matchAll(DURATION_PART).toArray();

    // Every character must belong to a part: "12" or "soon" or "-3s" is not a duration.
    if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) {
        return undefined;
    }

    let total = 0;

    for (const [, amount, unit] of parts) {
        total += Number(amount) * (UNIT_MS.get(unit ?? "") ?? 0);
    }

    // "1.2.3s" matched as a part but is no number.
    return Number.isNaN(total) ? undefined : Math.round(total);
};

const isRecord = (value: unknown): value is Loose => typeof value === "object" && value !== null;

const readStatus = (error: Loose): number | undefined => {
    const { status, statusCode } = error;

    if (typeof statusCode === "number") {
        return statusCode;
    }

    return typeof status === "number" ? status : undefined;
};

const lowerCaseKeys = (headers: unknown): Record<string, string> => {
    const result: Record<string, string> = {};

    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            result[key.toLowerCase()] = value;
        });

        return result;
    }

    if (isRecord(headers)) {
        for (const [key, value] of Object.entries(headers)) {
            if (typeof value === "string") {
                result[key.toLowerCase()] = value;
            }
        }
    }

    return result;
};

const parseJson = (text: unknown): unknown => {
    if (typeof text !== "string") {
        return isRecord(text) ? text : undefined;
    }

    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const secondsToMs = (text: string): number | undefined => {
    const seconds = Number(text);

    return text.trim() !== "" && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

/** A `retry-after` value: delta-seconds or an HTTP date. */
const retryAfterAt = (value: string, now: number): number | undefined => {
    const delta = secondsToMs(value);

    if (delta !== undefined) {
        return now + delta;
    }

    const date = Date.parse(value);

    return Number.isNaN(date) ? undefined : date;
};

/** The epoch ms one header pair says its limit has room again at, when that limit has nothing left. */
const resetOfHeader = (name: string, value: string, headers: Record<string, string>, now: number): number | undefined => {
    let remainingName: string;
    let resetAt: number | undefined;

    if (name.startsWith("x-ratelimit-reset-")) {
        // OpenAI / Groq: `x-ratelimit-reset-requests: 6m0s`, paired with `x-ratelimit-remaining-requests`.
        remainingName = name.replace("-reset-", "-remaining-");

        const duration = parseDuration(value);

        resetAt = duration === undefined ? undefined : now + duration;
    } else if (name.startsWith("anthropic-ratelimit-") && name.endsWith("-reset")) {
        // Anthropic: `anthropic-ratelimit-tokens-reset: <RFC 3339>`, paired with `...-tokens-remaining`.
        remainingName = name.replace(RESET_REMAINING, "-remaining");

        const date = Date.parse(value);

        resetAt = Number.isNaN(date) ? undefined : date;
    } else {
        return undefined;
    }

    return headers[remainingName] !== undefined && Number(headers[remainingName]) === 0 ? resetAt : undefined;
};

/** Reset headers of limits with nothing left: the latest of them is when every one has room again. */
const exhaustedResetAt = (headers: Record<string, string>, now: number): number | undefined => {
    let latest: number | undefined;

    for (const [name, value] of Object.entries(headers)) {
        const resetAt = resetOfHeader(name, value, headers, now);

        if (resetAt !== undefined) {
            latest = Math.max(latest ?? 0, resetAt);
        }
    }

    return latest;
};

/** `"34s"` (a protobuf Duration as JSON) or `{ seconds, nanos }`. */
const protobufDelayMs = (value: unknown): number | undefined => {
    if (typeof value === "string") {
        return parseDuration(value);
    }

    if (isRecord(value) && (typeof value.seconds === "number" || typeof value.seconds === "string")) {
        const delay = Math.round(Number(value.seconds) * 1000 + (typeof value.nanos === "number" ? value.nanos / 1e6 : 0));

        return Number.isFinite(delay) ? delay : undefined;
    }

    return undefined;
};

/** Google: `error.details[].retryDelay` on the `RetryInfo` entry. */
const detailsRetryAt = (error: Loose, now: number): number | undefined => {
    const details: unknown[] = Array.isArray(error.details) ? error.details : [];

    for (const detail of details) {
        const delay = isRecord(detail) ? protobufDelayMs(detail.retryDelay) : undefined;

        if (delay !== undefined) {
            return now + delay;
        }
    }

    return undefined;
};

/** OpenRouter relays the upstream headers under `error.metadata.headers`. */
const relayedResetAt = (error: Loose): number | undefined => {
    const relayed = isRecord(error.metadata) && isRecord(error.metadata.headers) ? lowerCaseKeys(error.metadata.headers) : {};
    const reset = Number(relayed["x-ratelimit-reset"]);

    if (relayed["x-ratelimit-reset"] === undefined || !Number.isFinite(reset) || reset <= 0) {
        return undefined;
    }

    return reset >= EPOCH_MS_FLOOR ? reset : reset * 1000;
};

/** The gateway's own refusals and a few providers: `retryAfter` / `retry_after` in seconds. */
const fieldRetryAt = (error: Loose, now: number): number | undefined => {
    for (const key of ["retryAfter", "retry_after"]) {
        const seconds = error[key];

        if (typeof seconds === "number" && seconds >= 0) {
            return now + Math.round(seconds * 1000);
        }
    }

    return undefined;
};

/** OpenAI, Groq and Mistral state the wait only in the message. */
const messageRetryAt = (error: Loose, now: number): number | undefined => {
    const wait = typeof error.message === "string" ? MESSAGE_WAIT.exec(error.message)?.[1]?.replace(TRAILING_DOT, "") : undefined;
    const duration = wait === undefined ? undefined : parseDuration(wait);

    return duration === undefined ? undefined : now + duration;
};

/** A provider's body (or an error object), looked through for the field that names the wait. */
const bodyRetryAt = (body: unknown, now: number): number | undefined => {
    if (!isRecord(body)) {
        return undefined;
    }

    const error = isRecord(body.error) ? body.error : body;

    return detailsRetryAt(error, now) ?? relayedResetAt(error) ?? fieldRetryAt(error, now) ?? messageRetryAt(error, now);
};

const nestedErrorOf = (error: Loose, body: unknown): Loose | undefined => {
    if (isRecord(error.error)) {
        return error.error;
    }

    return isRecord(body) && isRecord(body.error) ? body.error : undefined;
};

/** OpenAI answers 429 for an account with no quota left, which no wait cures: `error.code` / `error.type` is `insufficient_quota`. */
const isQuotaExhausted = (error: Loose, body: unknown): boolean => {
    const nested = nestedErrorOf(error, body);

    return [error.code, error.type, nested?.code, nested?.type].some((code) => typeof code === "string" && code.toLowerCase() === "insufficient_quota");
};

const isThrottleCode = (error: Loose, body: unknown): boolean => {
    const nested = nestedErrorOf(error, body);
    const codes = [error.code, error.name, nested?.code, nested?.type, nested?.status];

    return codes.some((code) => typeof code === "string" && THROTTLE_CODES.has(code.toLowerCase()));
};

/** The retry time the response states, in the order the module comment gives. */
const readRetryAt = (error: Loose, headers: Record<string, string>, body: unknown, now: number): number | undefined => {
    const retryAfterMs = Number(headers["retry-after-ms"]);

    if (headers["retry-after-ms"] !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
        return now + Math.round(retryAfterMs);
    }

    const retryAfter = headers["retry-after"] === undefined ? undefined : retryAfterAt(headers["retry-after"], now);

    return retryAfter ?? bodyRetryAt(body, now) ?? bodyRetryAt(error, now) ?? exhaustedResetAt(headers, now);
};

/**
 * The provider's rate limit behind `error`, or `undefined` when it is not one.
 * A 429 always is, with or without a retry time; a 408 / 5xx only when it names one.
 * Reads structured fields only — status, headers, body fields — never a message to decide the status.
 */
export const readRateLimit = (error: unknown, now: number = Date.now()): RateLimitInfo | undefined => {
    if (!isRecord(error)) {
        return undefined;
    }

    const headers = lowerCaseKeys(error.responseHeaders ?? error.headers);
    const body = parseJson(error.responseBody ?? error.data);
    const retryAt = readRetryAt(error, headers, body, now);
    const status = readStatus(error) ?? (isThrottleCode(error, body) ? 429 : undefined);

    if (status === undefined || isQuotaExhausted(error, body)) {
        return undefined;
    }

    const isRateLimit = status === 429 || ((status === 408 || status >= 500) && retryAt !== undefined);

    if (!isRateLimit) {
        return undefined;
    }

    if (retryAt === undefined) {
        return { status };
    }

    // A time that is not a number ("Infinity", NaN) means no wait will do: send one far enough out that the backend refuses
    // it as too long, not nothing, which the backend would read as "no time given" and wait the default for.
    return { retryAt: Number.isFinite(retryAt) ? Math.max(now, retryAt) : NEVER_AT, status };
};
