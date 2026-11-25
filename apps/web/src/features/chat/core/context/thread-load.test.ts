import { describe, expect, it } from "vitest";

import { threadLoadOf } from "./thread-load";

describe(threadLoadOf, () => {
    it("is loading until the thread's read first answers", () => {
        expect(threadLoadOf("t1", false, { isError: false, isPending: true })).toBe("loading");
    });

    it("failed when the read failed with no thread to show", () => {
        expect(threadLoadOf("t1", false, { isError: true, isPending: false })).toBe("failed");
    });

    it.each([
        ["a thread is shown, even after a failed refresh", "t1", true, { isError: true, isPending: false }],
        ["the read answered that there is none", "t1", false, { isError: false, isPending: false }],
        ["there is no thread to read", undefined, false, { isError: false, isPending: true }],
    ])("is ready when %s", (_case, threadId, hasThread, read) => {
        expect(threadLoadOf(threadId, hasThread, read)).toBe("ready");
    });
});
