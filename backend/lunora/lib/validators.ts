/**
 * Validator helpers that Lunora's `v` does not ship itself.
 *
 * Everything here operates on ordinary Lunora validators through Standard Schema
 * v1, which they implement. Nothing in this file is a compatibility shim for
 * another platform.
 */
import { LunoraError, v } from "lunorash/server";
import type { Infer, Validator } from "lunorash/server";

interface StandardValidator {
    "~standard"?: { validate: (value: unknown) => unknown };
}

const standardOf = (validator: unknown) => (validator as StandardValidator)["~standard"];

/**
 * `T | null`.
 *
 * `v.optional()` is about a key being ABSENT; this is about it being present and
 * explicitly null, which is what a nullable column holds.
 */
export const nullable = <V extends Validator>(validator: V) => v.union(validator, v.null());

/**
 * Length caps for string arguments of client-reachable procedures:
 * `v.string().max(MAX_LENGTH.short)`. They bound what one request can make the
 * server store or process. Each sits well above what a legitimate client sends,
 * so none of them is a product limit.
 *
 * - `id`: row and user ids (a row id is a 36-character UUID, a better-auth id 32).
 * - `cursor`: opaque pagination cursors the server handed out.
 * - `short`: names, titles, slugs, model ids, emails, tags, languages.
 * - `key`: storage keys and relative paths (`vault/<user>/<uuid>/<file name>`).
 * - `url`: URLs and icons.
 * - `long`: descriptions, notes, search queries, settings blobs.
 * - `text`: prompts, instructions, eval inputs, variables. The public API caps
 *   a prompt at 100,000 characters; this is twice that.
 * - `document`: whole documents (page and artifact content, slide HTML,
 *   imported files). A Durable Object's SQLite row holds at most 2 MB, so
 *   nothing longer could be stored anyway.
 *
 * Any field that can carry a data URL, base64, serialized JSON/CSV, code, SVG
 * or HTML takes `document`, whatever its name: an organization `logo` (the web
 * uploads it as base64), instructions, system prompts, memory text, variable
 * values, import payloads.
 *
 * Write the cap INLINE in `.input({...})`: the advisor's `unbounded_string_arg`
 * reads only the syntax there. (The caps also once kept the advisor's finding
 * count under a TS2590 limit in the generated `shard.ts`; that is fixed since
 * `@lunora/codegen@alpha.214`, anolilab/lunora#823, so they are input bounds
 * only.)
 */
export const MAX_LENGTH = {
    cursor: 8192,
    document: 2_000_000,
    id: 128,
    key: 1024,
    long: 10_000,
    short: 500,
    text: 200_000,
    url: 8192,
} as const;

/**
 * The `{ numItems, cursor }` shape `ctx.db.paginate` takes. A cursor is an
 * opaque position the server handed out; the cap only refuses a payload no
 * cursor of ours comes near.
 */
export const paginationOptionsValidator = v.object({
    cursor: nullable(v.string().max(MAX_LENGTH.cursor)),
    endCursor: v.optional(nullable(v.string().max(MAX_LENGTH.cursor))),
    id: v.optional(v.number()),
    maximumRowsRead: v.optional(v.number()),
    numItems: v.number(),
});

/** `true` if `value` satisfies `validator`. Async validators count as a failure. */
export const validate = (validator: unknown, value: unknown): boolean => {
    const standard = standardOf(validator);

    if (!standard) {
        return false;
    }

    const result = standard.validate(value);

    return result instanceof Promise ? false : (result as { issues?: unknown }).issues === undefined;
};

/**
 * Parse `value`, or throw.
 *
 * The return type is inferred from the VALIDATOR. Taking a caller-supplied `T`
 * gives it nothing to infer from, so it resolves to `unknown` at every call site.
 */
export const parse = <V extends Validator>(validator: V, value: unknown): Infer<V> => {
    const standard = standardOf(validator);

    if (!standard) {
        throw new LunoraError("VALIDATION_ERROR", "parse() received a value that is not a Standard Schema validator");
    }

    const result = standard.validate(value);

    if (result instanceof Promise) {
        throw new LunoraError("VALIDATION_ERROR", "parse() does not support async validators");
    }

    const typed = result as { issues?: ReadonlyArray<{ message: string }>; value?: Infer<V> };

    if (typed.issues) {
        throw new LunoraError("VALIDATION_ERROR", typed.issues.map((issue) => issue.message).join("; "));
    }

    return typed.value as Infer<V>;
};

/**
 * Every field made optional, for patch-style arguments — of an object validator,
 * or of a plain `{ field: validator }` record (what `pick(...)` returns, and how
 * every caller uses it).
 *
 * The record form used to come back UNCHANGED, so each `v.object(partial(pick(…)))`
 * patch still required every required column: `updateProject` refused any patch
 * without a `title` (the gallery fork-count bump, a workflow content save) at
 * runtime, while the types said it was fine.
 */
export const partial = <T>(validator: T): T => {
    // The only property read here is `fields`, and the only one written on each
    // field validator is `isOptional`; everything else is carried through by the
    // spread without being named.
    const { fields } = validator as { fields?: Record<string, { isOptional?: string }> };

    if (!fields) {
        const record = validator as Record<string, Validator<unknown> & { isOptional?: string }>;

        return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.isOptional === "optional" ? value : v.optional(value)])) as T;
    }

    return {
        ...validator,
        fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { ...value, isOptional: "optional" }])),
    } as T;
};

/**
 * Caps an open-ended JSON argument (an editor document, node payload or skill
 * parameters) by its serialized size. Those shapes belong to their editors, so
 * they cannot be typed precisely without dropping fields the editor needs; the
 * size is the part of the risk that a server can bound. The cap is the document
 * text cap, since a stored row cannot hold more than that anyway.
 */
export const assertJsonWithinLimit = (value: unknown, label: string): void => {
    if (value === undefined) {
        return;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;

    if (bytes > MAX_LENGTH.document) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", `${label} is larger than ${String(MAX_LENGTH.document)} bytes`);
    }
};

/**
 * Nesting cap for JSON document arguments. ProseMirror and Fabric documents nest
 * well under this; the cap only stops a pathological payload from recursing the
 * validator arbitrarily deep. The byte cap is `assertJsonWithinLimit`.
 */
const JSON_MAX_DEPTH = 256;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (value: unknown, depth: number): boolean => {
    if (depth > JSON_MAX_DEPTH) {
        return false;
    }

    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }

    if (typeof value === "number") {
        return Number.isFinite(value);
    }

    if (Array.isArray(value)) {
        return value.every((item) => isJsonValue(item, depth + 1));
    }

    if (isPlainObject(value)) {
        return Object.values(value).every((item) => isJsonValue(item, depth + 1));
    }

    return false;
};

/**
 * A Standard Schema for JSON data, wrapped with `v.from(...)`.
 *
 * `v` has no recursive constructor, so a JSON value (ProseMirror and Fabric
 * documents, skill parameters, workflow node input and output) cannot be spelled
 * with `v.*` alone; `v.any()` was the only option, and the advisor's
 * `public_arg_uses_any` rule rejects it. This accepts exactly what a JSON
 * document is: objects, arrays, strings, finite numbers, booleans and null. It
 * rejects `undefined`, functions, dates and `NaN`, which a JSON wire never
 * carries anyway.
 *
 * The input type is `unknown` on purpose: the argument already was `unknown` to
 * clients (`v.any()`), so generated client types do not change. Size is bounded by
 * `assertJsonWithinLimit` in each handler.
 */
export const vJsonValue = v.from({
    "~standard": {
        types: undefined as unknown as { input: unknown; output: unknown },
        validate: (value: unknown) => (isJsonValue(value, 0) ? { value } : { issues: [{ message: "Expected JSON data" }] }),
        vendor: "neore",
        version: 1 as const,
    },
});

/**
 * A JSON object (a plain object whose values are JSON), for fields that are always
 * objects, such as the nodes and edges of a workflow graph.
 */
export const vJsonObject = v.from({
    "~standard": {
        types: undefined as unknown as { input: unknown; output: Record<string, unknown> },
        validate: (value: unknown) => (isPlainObject(value) && isJsonValue(value, 0) ? { value } : { issues: [{ message: "Expected a JSON object" }] }),
        vendor: "neore",
        version: 1 as const,
    },
});
