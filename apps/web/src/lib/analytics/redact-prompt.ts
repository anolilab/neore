/**
 * A prompt link carries a person's own text in its `prompt` query parameter. That text must never leave the browser in analytics
 * or error reports, so every event is passed through `redactPromptFromEvent` before PostHog sends it (`before_send` in
 * `providers/analytics-provider.tsx`). Every route is covered by that one hook. The page URL (`$current_url`), the referrer, the
 * URL an error report names, and any URL inside a session-replay snapshot are all strings in the event, so they are cleaned the
 * same way, wherever they sit. A sign-in page's return URL nests the link inside its own `redirectTo` parameter, encoded.
 *
 * Only a prompt parameter is removed, and a nested link's own prompt: every other query parameter and the fragment are kept byte
 * for byte. An event that names no prompt is returned as the same object, so nothing is copied for it.
 */

/** A prompt parameter's text, in decoded text: a `prompt=` that starts a query or a fragment, or follows `?`, `&` or `#`. */
const PROMPT_PARAMETER = /(?:^|[?&#])prompt=/i;

/** A link nested as the value of another parameter starts its own query with `?` or `&`. A value that merely begins `prompt=` is text. */
const NESTED_PROMPT = /[?&#]prompt=/i;

/** A segment that is the prompt parameter itself, once decoded. */
const PROMPT_SEGMENT = /^prompt=/i;

/** Any `prompt=` at all, in decoded text. A snapshot that holds one is not sent. */
const PROMPT_ASSIGNMENT = /prompt=/i;

/** The word a prompt is named by. A string with no `%` and no such word cannot name a prompt, so it is not decoded at all. */
const PROMPT_WORD = /prompt/i;

/** Whether a string may name a prompt, checked before any decoding: an encoded key can hide the word, so a `%` always decodes. */
const mayNamePrompt = (value: string): boolean => value.includes("%") || PROMPT_WORD.test(value);

/** A run of percent-encoded bytes, decoded run by run so a malformed run does not stop the others. */
const ENCODED_RUN = /(?:%[\da-f]{2})+/gi;

/** Decoding stops as soon as a pass changes nothing; this bounds a value that keeps changing. Each pass removes one encoding layer. */
const MAX_DECODE_PASSES = 64;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
};

/** One run of percent-encoded bytes decoded, or left as it is when it is malformed. */
const decodeRun = (run: string): string => {
    try {
        return decodeURIComponent(run);
    } catch {
        return run;
    }
};

/**
 * The text with one level of percent-encoding removed. A nested link is decoded one level only: an `&` or `#` that the link itself
 * encoded stays encoded, so it is not taken for a separator in the link's own query.
 */
const decodeOnce = (text: string): string => text.replaceAll(ENCODED_RUN, (run) => decodeRun(run));

/** The text with all its percent-encoding removed, repeated while a pass still changes it. Used to find a prompt, never to split. */
const decodeFully = (text: string): string => {
    let current = text;

    for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
        const next = decodeOnce(current);

        if (next === current) {
            return current;
        }

        current = next;
    }

    return current;
};

/** One `&`-separated segment, or `undefined` when it is the prompt parameter and is removed. `redact` cleans a nested link. */
const redactSegment = (segment: string, redact: (text: string) => string): string | undefined => {
    if (PROMPT_SEGMENT.test(decodeFully(segment))) {
        return undefined;
    }

    const equals = segment.indexOf("=");

    if (equals === -1) {
        // No `=` written in the segment: an encoded link may still be the whole of it (a value encoded twice keeps its `=` encoded).
        if (!NESTED_PROMPT.test(decodeFully(segment))) {
            return segment;
        }

        return encodeURIComponent(redact(decodeOnce(segment)));
    }

    const rawValue = segment.slice(equals + 1);

    if (!NESTED_PROMPT.test(decodeFully(rawValue))) {
        return segment;
    }

    return `${segment.slice(0, equals)}=${encodeURIComponent(redact(decodeOnce(rawValue)))}`;
};

/** A query with its prompt parameters removed. Every other segment is kept as it was written. */
const redactQuery = (query: string, redact: (text: string) => string): string =>
    query
        .split("&")
        .map((segment) => redactSegment(segment, redact))
        .filter((segment): segment is string => segment !== undefined)
        .join("&");

/**
 * A URL, or any string that may hold one, with no prompt text left in it. The prompt parameter and a nested link's prompt are
 * removed; every other query parameter and the fragment are kept as written. A string that names no prompt is returned as it is.
 */
export const redactPromptFromUrl = (value: string): string => {
    if (!mayNamePrompt(value) || !PROMPT_PARAMETER.test(decodeFully(value))) {
        return value;
    }

    const hashAt = value.indexOf("#");
    const body = hashAt === -1 ? value : value.slice(0, hashAt);
    const fragment = hashAt === -1 ? undefined : value.slice(hashAt + 1);
    const cleanedFragment = fragment === undefined ? undefined : redactPromptFromUrl(fragment);
    // A fragment that held only the prompt leaves no `#` behind.
    const tail = cleanedFragment === undefined || (cleanedFragment === "" && fragment !== "") ? "" : `#${cleanedFragment}`;

    const queryAt = body.indexOf("?");

    if (queryAt === -1) {
        return `${redactQuery(body, redactPromptFromUrl)}${tail}`;
    }

    const path = redactQuery(body.slice(0, queryAt), redactPromptFromUrl);
    const rawQuery = body.slice(queryAt + 1);
    const query = redactQuery(rawQuery, redactPromptFromUrl);
    const head = query === "" && rawQuery !== "" ? path : `${path}?${query}`;

    return `${head}${tail}`;
};

const containsPrompt = (value: unknown): boolean => {
    if (typeof value === "string") {
        return mayNamePrompt(value) && PROMPT_ASSIGNMENT.test(decodeFully(value));
    }

    if (Array.isArray(value)) {
        return value.some((item) => containsPrompt(item));
    }

    return isPlainObject(value) && Object.values(value).some((item) => containsPrompt(item));
};

/**
 * Every string in `value`, at any depth, cleaned by `redactPromptFromUrl`. Only a plain array or object is walked; anything else
 * (a `Date`, a class instance) is kept as it is. A container with nothing to change is returned as the same object.
 */
/** How deep the walk goes into an event. An event is shallow; past this depth a value is dropped rather than sent unchecked. */
const MAX_EVENT_DEPTH = 64;

const redactDeep = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_EVENT_DEPTH) {
        return undefined;
    }

    if (typeof value === "string") {
        return redactPromptFromUrl(value);
    }

    if (Array.isArray(value)) {
        let changed = false;
        const items = value.map((item) => {
            const next = redactDeep(item, depth + 1);

            changed ||= next !== item;

            return next;
        });

        return changed ? items : value;
    }

    if (isPlainObject(value)) {
        // A key is text too: a property named from a link carries its prompt, so the key is cleaned as a string value is.
        let changed = false;
        const entries = Object.entries(value).map(([key, item]) => {
            const cleanKey = redactPromptFromUrl(key);
            const next = redactDeep(item, depth + 1);

            changed ||= next !== item || cleanKey !== key;

            return [cleanKey, next] as const;
        });

        return changed ? Object.fromEntries(entries) : value;
    }

    return value;
};

/**
 * A session recording snapshot is not scrubbed in its compressed parts: the recorder gzips a page's full DOM and its text, so a
 * prompt in them is not readable here. A snapshot is therefore dropped when its page URL names a prompt, or when any plain string
 * in it does (the page's own address, recorded in a plain meta event, is one of them).
 */
const isPromptSnapshot = (event: unknown): boolean => {
    if (!isPlainObject(event) || event.event !== "$snapshot") {
        return false;
    }

    const properties = isPlainObject(event.properties) ? event.properties : {};

    return containsPrompt(properties.$current_url) || containsPrompt(properties.$snapshot_data);
};

/**
 * The PostHog `before_send` hook: the event as it would be sent, with no prompt text left in any URL it carries. Returns `null`
 * for an event that must not be sent at all (a recording snapshot of a prompt link's page), which PostHog then drops.
 */
export const redactPromptFromEvent = <T>(event: T): T | null => {
    if (isPromptSnapshot(event)) {
        return null;
    }

    return redactDeep(event) as T;
};
