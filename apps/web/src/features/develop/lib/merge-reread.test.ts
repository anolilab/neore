import { describe, expect, it } from "vitest";

import { MERGE_UNKNOWN_REREAD_FOR_MS, MERGE_UNKNOWN_REREAD_MS, nextMergeReread } from "./merge-reread";

const unknown = { mergeUnknown: true, state: "open", status: "ok" };

describe(nextMergeReread, () => {
    it("re-reads soon while the merge state is unknown, and starts the window at the first unknown answer", () => {
        expect(nextMergeReread(unknown, undefined, 1000)).toStrictEqual({ delay: MERGE_UNKNOWN_REREAD_MS, since: 1000 });
        expect(nextMergeReread(unknown, 1000, 1000 + MERGE_UNKNOWN_REREAD_FOR_MS - 1)).toStrictEqual({ delay: MERGE_UNKNOWN_REREAD_MS, since: 1000 });
    });

    it("stops once the window has passed", () => {
        expect(nextMergeReread(unknown, 1000, 1000 + MERGE_UNKNOWN_REREAD_FOR_MS)).toStrictEqual({ delay: false, since: 1000 });
    });

    it.each([
        ["a known merge state", { mergeUnknown: false, state: "open", status: "ok" }],
        ["a closed pull request", { mergeUnknown: true, state: "closed", status: "ok" }],
        ["a failed read", { status: "host_error" }],
        ["no answer yet", undefined],
    ])("does not re-read for %s, and ends the run so a later unknown starts a new window", (_label, data) => {
        expect(nextMergeReread(data, 1000, 500_000)).toStrictEqual({ delay: false, since: undefined });
        expect(nextMergeReread(unknown, undefined, 500_000)).toStrictEqual({ delay: MERGE_UNKNOWN_REREAD_MS, since: 500_000 });
    });
});
