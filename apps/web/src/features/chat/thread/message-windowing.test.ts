import { afterEach, describe, expect, it } from "vitest";

import {
    ALWAYS_MOUNTED_TAIL,
    getWindowPlan,
    parseMessageHash,
    readVirtualizeFlag,
    resolveJumpMessageId,
    resolveJumpTarget,
    shouldAnimateEntrance,
    VIRTUALIZE_FLAG_KEY,
    VIRTUALIZE_THRESHOLD,
} from "./message-windowing";

describe(getWindowPlan, () => {
    it("never virtualizes when disabled", () => {
        expect(getWindowPlan(500, { enabled: false })).toStrictEqual({ headCount: 0, virtualized: false });
    });

    it("keeps every message mounted at or below the threshold", () => {
        expect(getWindowPlan(VIRTUALIZE_THRESHOLD, { enabled: true })).toStrictEqual({ headCount: 0, virtualized: false });
    });

    it("virtualizes everything but the tail past the threshold", () => {
        const count = VIRTUALIZE_THRESHOLD + 1;

        expect(getWindowPlan(count, { enabled: true })).toStrictEqual({ headCount: count - ALWAYS_MOUNTED_TAIL, virtualized: true });
    });

    it("does not virtualize when the tail alone covers the thread", () => {
        expect(getWindowPlan(40, { enabled: true, tail: 50, threshold: 10 })).toStrictEqual({ headCount: 0, virtualized: false });
    });
});

describe(resolveJumpTarget, () => {
    const ids = Array.from({ length: 100 }, (_, index) => `m${index}`);
    const plan = getWindowPlan(ids.length, { enabled: true });

    it("routes a virtualized message through the head", () => {
        expect(resolveJumpTarget(ids, "m3", plan)).toStrictEqual({ index: 3, kind: "head" });
    });

    it("finds a tail message directly", () => {
        expect(resolveJumpTarget(ids, "m99", plan)).toStrictEqual({ index: 99, kind: "tail" });
    });

    it("treats every message as tail when not virtualized", () => {
        expect(resolveJumpTarget(ids, "m3", { headCount: 0, virtualized: false })).toStrictEqual({ index: 3, kind: "tail" });
    });

    it("reports a message that is not loaded", () => {
        expect(resolveJumpTarget(ids, "nope", plan)).toStrictEqual({ kind: "missing" });
    });
});

describe(shouldAnimateEntrance, () => {
    const initialIds = new Set(["a", "b"]);

    it("animates a new last user message", () => {
        expect(shouldAnimateEntrance({ index: 2, initialIds, messageId: "c", role: "user", total: 3 })).toBe(true);
    });

    it("does not animate a message present on first render (remount after virtualization)", () => {
        expect(shouldAnimateEntrance({ index: 1, initialIds, messageId: "b", role: "user", total: 2 })).toBe(false);
    });

    it("does not animate a new message that is no longer last", () => {
        expect(shouldAnimateEntrance({ index: 2, initialIds, messageId: "c", role: "user", total: 4 })).toBe(false);
    });

    it("does not animate assistant rows, which replace the streaming placeholder", () => {
        expect(shouldAnimateEntrance({ index: 2, initialIds, messageId: "c", role: "assistant", total: 3 })).toBe(false);
    });
});

describe(parseMessageHash, () => {
    it("reads a message deep link", () => {
        expect(parseMessageHash("#message-abc%20d")).toBe("abc d");
    });

    it("ignores other hashes", () => {
        expect(parseMessageHash("#section")).toBeUndefined();
        expect(parseMessageHash("")).toBeUndefined();
    });
});

describe(readVirtualizeFlag, () => {
    afterEach(() => {
        localStorage.removeItem(VIRTUALIZE_FLAG_KEY);
    });

    it("defaults off", () => {
        expect(readVirtualizeFlag()).toBe(false);
    });

    it("is on only for the literal '1'", () => {
        localStorage.setItem(VIRTUALIZE_FLAG_KEY, "1");

        expect(readVirtualizeFlag()).toBe(true);
    });
});

describe(resolveJumpMessageId, () => {
    const messages = [
        { id: "u1", order: 1, stepOrder: 0 },
        { id: "a1", order: 1, stepOrder: 1 },
        { id: "u2", order: 2, stepOrder: 0 },
    ];

    it("prefers an exact id match", () => {
        expect(resolveJumpMessageId(messages, "u2")).toBe("u2");
    });

    it("maps a merged assistant step to the rendered message that owns it", () => {
        expect(resolveJumpMessageId(messages, "a1-step3", { order: 1, stepOrder: 3 })).toBe("a1");
    });

    it("reports a message that is not loaded", () => {
        expect(resolveJumpMessageId(messages, "zzz")).toBeUndefined();
        expect(resolveJumpMessageId(messages, "zzz", { order: 0, stepOrder: 0 })).toBeUndefined();
    });
});
