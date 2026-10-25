import { describe, expect, it } from "vitest";

import type { PayloadFilterRow } from "./trigger-filters";
import { filtersToSend, hasIncompleteFilters, isCompleteFilter, isValidFilterPath, MAX_FILTER_VALUE_LENGTH } from "./trigger-filters";

const row = (overrides: Partial<PayloadFilterRow> = {}): PayloadFilterRow => {
    return { op: "equals", path: "action", value: "opened", ...overrides };
};

describe("isCompleteFilter", () => {
    it("accepts an empty comparison value, as the backend does", () => {
        const ops = ["contains", "equals", "not_equals", "starts_with"] as const;

        const verdicts = ops.map((op) => {
            const filter = row({ op, value: "" });

            return isCompleteFilter(filter);
        });

        expect(verdicts).toEqual([true, true, true, true]);
        expect(filtersToSend([row({ value: "" })])).toEqual([{ op: "equals", path: "action", value: "" }]);
    });

    it("still refuses a value past the cap and a missing path", () => {
        const tooLong = row({ value: "x".repeat(MAX_FILTER_VALUE_LENGTH + 1) });

        expect(isCompleteFilter(tooLong)).toBe(false);
        expect(isCompleteFilter(row({ path: "" }))).toBe(false);
    });

    it("needs no value for exists and not_exists", () => {
        expect(isCompleteFilter(row({ op: "exists", value: "" }))).toBe(true);
        expect(filtersToSend([row({ op: "not_exists", value: "ignored" })])).toEqual([{ op: "not_exists", path: "action" }]);
    });
});

describe("isValidFilterPath", () => {
    it("refuses the segments the backend refuses", () => {
        for (const path of ["__proto__", "payload.constructor", "a.prototype.b", "a..b", ""]) {
            expect(isValidFilterPath(path)).toBe(false);
        }

        expect(isValidFilterPath("pull_request.user.login")).toBe(true);
    });
});

describe("hasIncompleteFilters", () => {
    const incomplete = [row({ path: "" })];

    it("blocks a webhook trigger with an incomplete filter", () => {
        expect(hasIncompleteFilters("webhook", incomplete)).toBe(true);
    });

    it("ignores filters hidden on a non-webhook trigger", () => {
        expect(hasIncompleteFilters("schedule", incomplete)).toBe(false);
        expect(hasIncompleteFilters("event", incomplete)).toBe(false);
    });

    it("lets a webhook trigger with an empty-value filter through", () => {
        expect(hasIncompleteFilters("webhook", [row({ value: "" })])).toBe(false);
    });
});
