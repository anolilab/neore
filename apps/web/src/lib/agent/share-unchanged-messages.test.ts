import { describe, expect, it } from "vitest";

import { shareUnchangedMessages } from "./share-unchanged-messages";

const message = (id: string, text: string) => {
    return { id, parts: [{ text, type: "text" }], status: "success" };
};

describe(shareUnchangedMessages, () => {
    it("returns the previous array when a push changed nothing", () => {
        const previous = [message("a", "one"), message("b", "two")];

        expect(shareUnchangedMessages(previous, structuredClone(previous))).toBe(previous);
    });

    it("keeps unchanged messages and replaces the changed one", () => {
        const previous = [message("a", "one"), message("b", "two")];
        const next = structuredClone(previous);

        next[1]!.parts[0]!.text = "two, edited";

        const shared = shareUnchangedMessages(previous, next);

        expect(shared).not.toBe(previous);
        expect(shared[0]).toBe(previous[0]);
        expect(shared[1]).not.toBe(previous[1]);
        expect(shared[1]).toStrictEqual(next[1]);
    });

    it("matches by id, so prepending older messages keeps the loaded ones", () => {
        const previous = [message("b", "two"), message("c", "three")];
        const next = [message("a", "one"), ...structuredClone(previous)];

        const shared = shareUnchangedMessages(previous, next);

        expect(shared[0]).toBe(next[0]);
        expect(shared[1]).toBe(previous[0]);
        expect(shared[2]).toBe(previous[1]);
    });

    it("does not share a message that was removed and replaced", () => {
        const previous = [message("a", "one")];
        const next = [message("b", "one")];

        expect(shareUnchangedMessages(previous, next)[0]).toBe(next[0]);
    });
});
