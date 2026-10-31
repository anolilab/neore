import { beforeEach, describe, expect, it } from "vitest";

import type { DiffComment } from "./diff-comments";
import { finishSendAttempt, requestIdForAttempt } from "./diff-send-attempts";

const comment = (id: string): DiffComment => {
    return { id, messageId: "m1", path: "a.ts", text: "same words" };
};

beforeEach(() => {
    finishSendAttempt("t1");
    finishSendAttempt("t2");
});

describe("requestIdForAttempt", () => {
    it("keeps the id for a retry of the same draft, so a lost answer finds the first try", () => {
        const first = requestIdForAttempt("t1", [comment("c1"), comment("c2")], "text");

        expect(requestIdForAttempt("t1", [comment("c1"), comment("c2")], "text")).toBe(first);
    });

    it("mints a new id when the draft was edited", () => {
        const first = requestIdForAttempt("t1", [comment("c1")], "text");

        expect(requestIdForAttempt("t1", [comment("c1")], "text changed")).not.toBe(first);
        expect(requestIdForAttempt("t1", [comment("c1"), comment("c2")], "text changed")).not.toBe(first);
    });

    it("mints a new id for comments recreated with identical text, which are a new message, not a retry", () => {
        const first = requestIdForAttempt("t1", [comment("c1")], "text");

        expect(requestIdForAttempt("t1", [comment("c9")], "text")).not.toBe(first);
    });

    it("mints a new id once the attempt has finished", () => {
        const first = requestIdForAttempt("t1", [comment("c1")], "text");

        finishSendAttempt("t1");
        expect(requestIdForAttempt("t1", [comment("c1")], "text")).not.toBe(first);
    });

    it("keeps one thread's attempt apart from another's", () => {
        const first = requestIdForAttempt("t1", [comment("c1")], "text");

        expect(requestIdForAttempt("t2", [comment("c1")], "text")).not.toBe(first);
        expect(requestIdForAttempt("t1", [comment("c1")], "text")).toBe(first);
    });
});
