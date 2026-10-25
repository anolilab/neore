/**
 * Payload filters for webhook triggers.
 *
 * A filter is `{ path, op, value? }` evaluated against the parsed JSON body of a
 * delivery; every filter must match for the run to start. The body is untrusted
 * input, so everything here is bounded and none of it can be made to run code:
 * no regular expressions (ReDoS), paths read OWN properties only, and the caps
 * below are re-checked when a filter is evaluated, not just when it is saved.
 */
import { LunoraError } from "lunorash/server";

/** Filters per trigger. */
export const MAX_FILTERS = 10;

/** Segments in one path (`a.b.0.c` is four). */
export const MAX_PATH_DEPTH = 8;

/** Characters in one path. */
export const MAX_PATH_LENGTH = 200;

/** Bytes in a webhook delivery's body. The handler refuses a larger one, so no admitted payload is longer (in characters either). */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** UTF-8 text of `bytes`, or `null` when they are not valid UTF-8. A lossy decode would let bytes that are not JSON parse as JSON. */
export const decodeStrict = (bytes: Uint8Array): string | null => {
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
        return null;
    }
};

/**
 * The text the filters of a webhook delivery are evaluated against, both when the
 * handler receives it and when the run is admitted: the body, or the empty
 * (non-JSON) string when its bytes were not valid UTF-8. The handler flags that
 * (`invalidUtf8`) because the payload it hands on is the lossy decode.
 */
export const filterTextOf = (payload: string | undefined, invalidUtf8: boolean | undefined): string => (invalidUtf8 === true ? "" : (payload ?? ""));

/** Characters in a filter's comparison value. */
export const MAX_FILTER_VALUE_LENGTH = 500;

export const FILTER_OPS = ["equals", "not_equals", "contains", "starts_with", "exists", "not_exists"] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

export interface PayloadFilter {
    op: FilterOp;
    path: string;
    value?: string;
}

/** Ops that compare against `value`, so need one. */
const NEEDS_VALUE = new Set<FilterOp>(["contains", "equals", "not_equals", "starts_with"]);

/** Property names that would walk off the payload's own data. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const ARRAY_INDEX = /^(?:0|[1-9]\d{0,8})$/u;

/** Split a dotted path; `null` when it is empty, too long, too deep or names a forbidden property. */
const segmentsOf = (path: string): string[] | null => {
    if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
        return null;
    }

    const segments = path.split(".");

    if (segments.length > MAX_PATH_DEPTH || segments.some((segment) => segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment))) {
        return null;
    }

    return segments;
};

/**
 * Refuse a filter set that breaks the caps or is malformed. Run on every write,
 * so a stored set is always one the evaluator accepts.
 */
export const assertValidFilters = (filters: ReadonlyArray<PayloadFilter>): void => {
    if (filters.length > MAX_FILTERS) {
        throw new LunoraError("INVALID_ARGUMENT", `A trigger takes at most ${String(MAX_FILTERS)} payload filters.`);
    }

    for (const filter of filters) {
        if (segmentsOf(filter.path) === null) {
            throw new LunoraError(
                "INVALID_ARGUMENT",
                `A filter path is dotted property names, at most ${String(MAX_PATH_DEPTH)} deep and ${String(MAX_PATH_LENGTH)} characters.`,
            );
        }

        if (NEEDS_VALUE.has(filter.op) && (filter.value === undefined || filter.value.length > MAX_FILTER_VALUE_LENGTH)) {
            throw new LunoraError("INVALID_ARGUMENT", `The "${filter.op}" filter needs a value of at most ${String(MAX_FILTER_VALUE_LENGTH)} characters.`);
        }
    }
};

/** What `path` holds in `root`, or `undefined` when any step is missing. Own properties only. */
const readPath = (root: unknown, segments: ReadonlyArray<string>): unknown => {
    let current = root;

    for (const segment of segments) {
        if (Array.isArray(current)) {
            if (!ARRAY_INDEX.test(segment) || Number(segment) >= current.length) {
                return undefined;
            }

            current = current[Number(segment)];
        } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
            current = (current as Record<string, unknown>)[segment];
        } else {
            return undefined;
        }
    }

    return current;
};

/** Strings, numbers and booleans compare by their text; anything structured never equals a value. */
const scalarText = (value: unknown): string | undefined =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

const matches = (filter: PayloadFilter, payload: unknown): boolean => {
    const segments = segmentsOf(filter.path);

    if (segments === null) {
        return false;
    }

    const found = readPath(payload, segments);

    if (filter.op === "exists") {
        return found !== undefined && found !== null;
    }

    if (filter.op === "not_exists") {
        return found === undefined || found === null;
    }

    if (filter.value === undefined || filter.value.length > MAX_FILTER_VALUE_LENGTH) {
        return false;
    }

    const { value } = filter;
    const text = scalarText(found);

    switch (filter.op) {
        case "contains": {
            // A string holds a substring; an array holds an element.
            return Array.isArray(found) ? found.some((item) => scalarText(item) === value) : text?.includes(value) === true;
        }
        case "equals": {
            return text === value;
        }
        case "not_equals": {
            // A missing or structured value is "not equal": absence is what `not_exists` tests.
            return text !== value;
        }
        case "starts_with": {
            return text?.startsWith(value) === true;
        }
        default: {
            return false;
        }
    }
};

export type FilterResult = { filter: PayloadFilter; matched: false; reason: string } | { matched: true };

/**
 * Evaluate `filters` against a raw request body. Every filter must match; the
 * first that does not is returned. Fails closed: with filters set, a body that
 * is not a JSON object or array matches nothing, `not_exists` included.
 */
export const evaluateFilters = (filters: ReadonlyArray<PayloadFilter> | undefined, body: string): FilterResult => {
    if (!filters || filters.length === 0) {
        return { matched: true };
    }

    let payload: unknown;

    try {
        // An integer past the safe range would round to a neighbour and equal the wrong filter value,
        // so it is kept as its source text.
        payload = JSON.parse(body, (_key, value: unknown, context?: { source?: string }) =>
            typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER && context?.source !== undefined ? context.source : value,
        );
    } catch {
        payload = undefined;
    }

    const first = filters[0] as PayloadFilter;

    if (typeof payload !== "object" || payload === null) {
        return { filter: first, matched: false, reason: "The payload is not a JSON object." };
    }

    // Beyond the cap nothing is evaluated: a set that large cannot have been saved.
    if (filters.length > MAX_FILTERS) {
        return { filter: first, matched: false, reason: "Too many payload filters." };
    }

    for (const filter of filters) {
        if (!matches(filter, payload)) {
            return { filter, matched: false, reason: describeFilter(filter) };
        }
    }

    return { matched: true };
};

/** `path op value`, as shown in the history and the 202 body. */
export const describeFilter = (filter: PayloadFilter): string =>
    `${filter.path} ${filter.op.replace("_", " ")}${filter.value === undefined ? "" : ` "${filter.value}"`}`;
