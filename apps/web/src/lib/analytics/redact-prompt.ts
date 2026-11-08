import type { CaptureResult } from "posthog-js";

/**
 * A prompt link (`/chat?prompt=…`) carries a person's text in its address, and the page view PostHog captures names that address
 * before the chat removes the parameter. Every event passes through `redactPromptFromEvent` (`before_send`), which replaces the
 * value of any `prompt` parameter in the event's strings: a page URL, a referrer, and a link nested once-encoded in another
 * parameter, as a sign-in page's `redirectTo` nests the page it returns to.
 */

const REDACTED = "redacted";

/**
 * The parameter name `prompt`, any of whose letters may be percent-encoded (the router decodes a key before it reads it), as
 * `%70` in an address or `%2570` inside an encoded one. `escapes` are the prefixes an encoded letter may carry.
 */
const keyPattern = (escapes: ReadonlyArray<string>): string =>
    [..."prompt"]
        .map((letter) => {
            const hex = letter.codePointAt(0)!.toString(16);

            return `(?:${letter}|${escapes.map((escape) => `${escape}${hex}`).join("|")})`;
        })
        .join("");

/**
 * A `prompt` parameter in an address: its value runs to the next `&` or `#` (an `&` inside the text is encoded as `%26`), or to
 * a double quote, where an autocaptured `href="…"` in `$elements_chain` ends. Not at an apostrophe or a space: a link written in
 * a message can hold either raw, and stopping there would send the rest of the prompt.
 */
const PLAIN_PROMPT = new RegExp(`([?&]${keyPattern(["%"])}=)[^&#"]*`, "giu");

/** The same parameter in a link encoded once as another parameter's value: its value runs to the next encoded `&` or `#`. */
const ENCODED_PROMPT = new RegExp(`((?:%3F|%26)${keyPattern(["%", "%25"])}%3D)(?:[^%&#"]|%(?!26|23))*`, "giu");

/** Each prompt parameter keeps its name; its value is replaced. */
const redactString = (value: string): string =>
    value
        .replaceAll(PLAIN_PROMPT, (_match: string, name: string) => `${name}${REDACTED}`)
        .replaceAll(ENCODED_PROMPT, (_match: string, name: string) => `${name}${REDACTED}`);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
};

/**
 * `value` with every string in it redacted, keys included (heatmap data is filed under the page address); arrays and plain
 * objects are copied, anything else is kept as it is.
 */
const redactValue = <T>(value: T): T => {
    if (typeof value === "string") {
        return redactString(value) as T;
    }

    if (Array.isArray(value)) {
        return value.map((entry: unknown) => redactValue(entry)) as T;
    }

    if (isPlainObject(value)) {
        // Two keys that redact to the same one (heatmap data for two prompt links) are merged, not overwritten.
        const result: Record<string, unknown> = {};

        for (const [key, entry] of Object.entries(value)) {
            const redactedKey = redactString(key);
            const redactedEntry = redactValue(entry);
            const earlier = result[redactedKey];

            result[redactedKey] = Array.isArray(earlier) && Array.isArray(redactedEntry) ? [...earlier, ...redactedEntry] : redactedEntry;
        }

        return result as T;
    }

    return value;
};

export const redactPromptFromEvent = (event: CaptureResult | null): CaptureResult | null => (event === null ? null : redactValue(event));
