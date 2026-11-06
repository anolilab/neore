/**
 * A prompt link carries a person's own text in its `prompt` query parameter. That text must never leave the browser in analytics
 * or error reports, so every event is passed through `redactPromptFromEvent` before PostHog sends it (`before_send` in
 * `providers/analytics-provider.tsx`). Every route is covered by that one hook. The page URL (`$current_url`), the referrer, the
 * URL an error report names, and any URL inside a session-replay snapshot are all strings in the event, so they are cleaned the
 * same way, wherever they sit. A sign-in page's return URL nests the link inside its own `redirectTo` parameter, encoded, so a
 * nested link is cut as well as a top-level one.
 */

const PROMPT_PARAMETER = "prompt";

/**
 * The name of a `prompt` parameter followed by its value: plain (`prompt=`), or percent-encoded once or more (`prompt%3D`,
 * `prompt%253D`), which is how a link sits inside another URL's query. The text of a prompt always follows its name.
 */
const PROMPT_MARKER = /prompt(?:=|%(?:25)*3D)/i;

/** A separator left at the end of a value once it is cut before its prompt: a plain or encoded `?` or `&`. */
const TRAILING_SEPARATOR = /(?:\?|&|%3F|%26)$/i;

/** The word a prompt link's parameter is named with; a value without it cannot carry a prompt. */
const PROMPT_WORD = /prompt/i;

/** The value without any separators left at its end. */
const withoutTrailingSeparators = (value: string): string => {
    let trimmed = value;

    for (let found = TRAILING_SEPARATOR.exec(trimmed); found; found = TRAILING_SEPARATOR.exec(trimmed)) {
        trimmed = trimmed.slice(0, found.index);
    }

    return trimmed;
};

const RELATIVE_BASE = "https://relative.invalid";

/** The URL as it was written, with its top-level `prompt` parameter removed. A value that is not a URL, or has no such parameter, is returned unchanged. */
const withoutTopLevelPrompt = (value: string): string => {
    let absolute = true;
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        absolute = false;

        try {
            url = new URL(value, RELATIVE_BASE);
        } catch {
            return value;
        }
    }

    if (!url.searchParams.has(PROMPT_PARAMETER)) {
        return value;
    }

    url.searchParams.delete(PROMPT_PARAMETER);

    return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
};

/**
 * A URL, or any string that may hold one, with no prompt text left in it. A top-level `prompt` parameter is removed exactly. A
 * prompt still named further in (inside a nested link, plain or encoded) is cut from its name on, so nothing after it is kept.
 */
export const redactPromptFromUrl = (value: string): string => {
    if (!PROMPT_WORD.test(value)) {
        return value;
    }

    const withoutPrompt = withoutTopLevelPrompt(value);
    const marker = PROMPT_MARKER.exec(withoutPrompt);

    if (!marker) {
        return withoutPrompt;
    }

    return withoutTrailingSeparators(withoutPrompt.slice(0, marker.index));
};

/** Every string in `value`, at any depth, cleaned by `redactPromptFromUrl`. Copies what it walks; the input is not changed. */
const redactDeep = (value: unknown): unknown => {
    if (typeof value === "string") {
        return redactPromptFromUrl(value);
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
