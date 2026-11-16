import { describe, expect, it } from "vitest";

import {
    JUMP_MAX_PAGES,
    JUMP_MAX_PAGES_WITH_POSITION,
    parseMessageHash,
    resolveJumpMessageId,
    shouldAnimateEntrance,
    shouldLoadOlderForJump,
} from "./message-windowing";

describe(shouldAnimateEntrance, () => {
    const initialIds = new Set(["a", "b"]);

    it("animates a new last user message", () => {
        expect(shouldAnimateEntrance({ index: 2, initialIds, messageId: "c", role: "user", total: 3 })).toBe(true);
    });

    it("does not animate a message present on first render (a remount)", () => {
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

describe(shouldLoadOlderForJump, () => {
    const PAGE = 50;
    const TOTAL_TURNS = 2000;

    // The newest `loaded` turns of a thread, oldest first, like the paginated message list.
    const loadedTurns = (pages: number) => {
        const count = Math.min(TOTAL_TURNS, PAGE * (pages + 1));

        return Array.from({ length: count }, (_, index) => {
            return { id: `m${TOTAL_TURNS - count + index}`, order: TOTAL_TURNS - count + index, stepOrder: 0 };
        });
    };

    // Mirrors MessageList's jump loop: page older until the target resolves or the budget says stop.
    const pageUntilFound = (targetOrder: number, withPosition: boolean) => {
        let pagesLoaded = 0;
        const position = withPosition ? { order: targetOrder, stepOrder: 0 } : undefined;

        while (!resolveJumpMessageId(loadedTurns(pagesLoaded), `m${targetOrder}`, position)) {
            if (!shouldLoadOlderForJump(pagesLoaded, loadedTurns(pagesLoaded), position)) {
                return undefined;
            }

            pagesLoaded += 1;
        }

        return pagesLoaded;
    };

    it("reaches a message far older than the default page budget when its position is known", () => {
        const targetOrder = 100;

        expect(pageUntilFound(targetOrder, false)).toBeUndefined();
        expect(pageUntilFound(targetOrder, true)).toBeGreaterThan(JUMP_MAX_PAGES);
    });

    it("keeps the default budget when the position is unknown", () => {
        expect(shouldLoadOlderForJump(JUMP_MAX_PAGES - 1, loadedTurns(0))).toBe(true);
        expect(shouldLoadOlderForJump(JUMP_MAX_PAGES, loadedTurns(0))).toBe(false);
    });

    it("stops once the loaded history is older than the target, so a vanished message is reported", () => {
        const loaded = [{ order: 5 }, { order: 6 }];

        expect(shouldLoadOlderForJump(1, loaded, { order: 7 })).toBe(false);
        expect(shouldLoadOlderForJump(1, loaded, { order: 3 })).toBe(true);
    });

    it("is bounded even with a position", () => {
        expect(shouldLoadOlderForJump(JUMP_MAX_PAGES_WITH_POSITION, loadedTurns(0), { order: 1 })).toBe(false);
    });
});
