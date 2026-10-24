/**
 * Payload filters: every filter must match the parsed body, a missing path is
 * a failed match, and the body is untrusted, so the caps and the prototype
 * guard hold.
 */
import { describe, expect, it } from "vitest";

import type { PayloadFilter } from "./filters";
import { assertValidFilters, evaluateFilters, MAX_FILTERS, MAX_PATH_DEPTH, MAX_PATH_LENGTH } from "./filters";

const BODY = JSON.stringify({
    action: "opened",
    labels: [{ name: "bug" }, { name: "ui" }],
    number: 42,
    pull_request: { draft: false, title: "Fix the thing", user: { login: "octo" } },
    tags: ["a", "b"],
});

/** `a.a.a…` with `depth` segments. */
const pathOf = (depth: number): string => `${"a.".repeat(depth - 1)}a`;

const run = (filters: PayloadFilter[], body = BODY) => evaluateFilters(filters, body);

describe("evaluateFilters", () => {
    it("matches when no filters are set", () => {
        expect(evaluateFilters(undefined, "not json")).toEqual({ matched: true });
        expect(evaluateFilters([], "not json")).toEqual({ matched: true });
    });

    it("matches when every filter matches", () => {
        const result = run([
            { op: "equals", path: "action", value: "opened" },
            { op: "equals", path: "pull_request.user.login", value: "octo" },
            { op: "equals", path: "number", value: "42" },
            { op: "equals", path: "pull_request.draft", value: "false" },
            { op: "equals", path: "labels.1.name", value: "ui" },
            { op: "contains", path: "pull_request.title", value: "the" },
            { op: "contains", path: "tags", value: "b" },
            { op: "starts_with", path: "pull_request.title", value: "Fix" },
            { op: "not_equals", path: "action", value: "closed" },
            { op: "not_exists", path: "pull_request.merged_at" },
        ]);

        expect(result).toEqual({ matched: true });
    });

    it("reports the first failing filter and stops there", () => {
        const failing: PayloadFilter = { op: "equals", path: "action", value: "closed" };
        const result = run([{ op: "exists", path: "number" }, failing, { op: "equals", path: "nope", value: "x" }]);

        expect(result).toMatchObject({ filter: failing, matched: false, reason: 'action equals "closed"' });
    });

    it("treats a missing path as a failed match, except for not_exists and not_equals", () => {
        expect(run([{ op: "equals", path: "missing.deep", value: "x" }]).matched).toBe(false);
        expect(run([{ op: "contains", path: "missing", value: "x" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "missing" }]).matched).toBe(false);
        expect(run([{ op: "not_exists", path: "missing" }]).matched).toBe(true);
        expect(run([{ op: "not_equals", path: "missing", value: "x" }]).matched).toBe(true);
        expect(run([{ op: "equals", path: "labels.5.name", value: "x" }]).matched).toBe(false);
    });

    it("does not let structured values equal a string, nor a null count as present", () => {
        expect(run([{ op: "equals", path: "labels", value: "[object Object]" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "x" }], '{"x":null}').matched).toBe(false);
    });

    it("fails closed when the body is not a JSON object", () => {
        for (const body of ["not json", "42", "null", '"text"', ""]) {
            expect(run([{ op: "not_exists", path: "anything" }], body).matched).toBe(false);
        }

        expect(run([{ op: "exists", path: "0" }], "[1]").matched).toBe(true);
    });

    it("never walks the prototype chain", () => {
        expect(run([{ op: "exists", path: "constructor" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "__proto__" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "pull_request.constructor.name" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "toString" }]).matched).toBe(false);
        expect(run([{ op: "exists", path: "labels.length" }]).matched).toBe(false);
        // An own key that only LOOKS like a prototype probe in the payload is refused too.
        expect(run([{ op: "exists", path: "__proto__.polluted" }], '{"__proto__":{"polluted":1}}').matched).toBe(false);
    });

    it("re-checks the caps when evaluating, not only when saving", () => {
        const tooDeep = pathOf(MAX_PATH_DEPTH + 1);
        let nested: unknown = 1;

        for (let level = 0; level <= MAX_PATH_DEPTH; level += 1) {
            nested = { a: nested };
        }

        expect(run([{ op: "exists", path: tooDeep }], JSON.stringify(nested)).matched).toBe(false);
        expect(run([{ op: "exists", path: "a".repeat(MAX_PATH_LENGTH + 1) }]).matched).toBe(false);
        expect(run(Array.from({ length: MAX_FILTERS + 1 }, () => ({ op: "exists", path: "action" }) satisfies PayloadFilter)).matched).toBe(false);
    });
});

describe("assertValidFilters", () => {
    it("accepts a full, well-formed set", () => {
        const filters = Array.from({ length: MAX_FILTERS }, () => ({ op: "equals", path: pathOf(MAX_PATH_DEPTH), value: "x" }) satisfies PayloadFilter);

        expect(() => assertValidFilters(filters)).not.toThrow();
    });

    it("refuses too many filters, a deep or long path, and forbidden or empty segments", () => {
        expect(() => assertValidFilters(Array.from({ length: MAX_FILTERS + 1 }, () => ({ op: "exists", path: "a" }) satisfies PayloadFilter))).toThrow();
        expect(() => assertValidFilters([{ op: "exists", path: pathOf(MAX_PATH_DEPTH + 1) }])).toThrow();
        expect(() => assertValidFilters([{ op: "exists", path: "a".repeat(MAX_PATH_LENGTH + 1) }])).toThrow();

        for (const path of ["", "a..b", ".a", "a.", "__proto__", "a.constructor", "prototype.x"]) {
            expect(() => assertValidFilters([{ op: "exists", path }])).toThrow();
        }
    });

    it("requires a value exactly for the ops that compare", () => {
        expect(() => assertValidFilters([{ op: "equals", path: "a" }])).toThrow();
        expect(() => assertValidFilters([{ op: "contains", path: "a", value: "x".repeat(501) }])).toThrow();
        expect(() => assertValidFilters([{ op: "exists", path: "a" }])).not.toThrow();
    });
});
