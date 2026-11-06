/**
 * A prompt link carries a person's own text in its `prompt` query parameter. That text must never leave the browser in analytics
 * or error reports, so every event is passed through `redactPromptFromEvent` before PostHog sends it (`before_send` in
 * `providers/analytics-provider.tsx`). The page URL (`$current_url`), the referrer, the URL an error report names, and any URL
 * inside a session-replay snapshot are all strings in the event, so they are cleaned the same way, wherever they sit.
 */

const PROMPT_PARAMETER = "prompt";

/** A `prompt` parameter with its separator, and the separator left behind at the end of a query or before a fragment. */
const PROMPT_IN_QUERY = /([?&])prompt=[^&#]*&?/g;
const TRAILING_SEPARATOR = /[?&](?=#|$)/;

/** A URL without its `prompt` parameter. A value without one is returned unchanged. */
export const redactPromptFromUrl = (value: string): string => {
    if (!value.includes(`${PROMPT_PARAMETER}=`)) {
        return value;
    }

    try {
        const url = new URL(value);

        url.searchParams.delete(PROMPT_PARAMETER);

        return url.href;
    } catch {
        // Not an absolute URL (a path and query, as a snapshot can carry): the parameter is dropped by hand, keeping any fragment.
        return value.replaceAll(PROMPT_IN_QUERY, "$1").replace(TRAILING_SEPARATOR, "");
    }
};

/** Every string in `value`, at any depth, with a prompt parameter removed from it. Copies what it walks; the input is not changed. */
const redactDeep = (value: unknown): unknown => {
    if (typeof value === "string") {
        return value.includes(`${PROMPT_PARAMETER}=`) ? redactPromptFromUrl(value) : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactDeep(item));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
    }

    return value;
};

/** The PostHog `before_send` hook: the event as it would be sent, with no prompt text left in any URL it carries. */
export const redactPromptFromEvent = <T>(event: T): T => redactDeep(event) as T;
