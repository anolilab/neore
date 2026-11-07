import { describe, expect, it } from "vitest";

import { clearedCommandRange, isBareCommand, isBareCompact, isPrefixOfCommand, isWholeDraft } from "./slash-command";

describe(isBareCompact, () => {
    it("runs `/compact` alone", () => {
        expect.assertions(1);

        expect(isBareCompact({ command: "compact", query: "", wholeDraft: true })).toBe(true);
    });

    it("leaves `/compact` with text after it to be sent as a message", () => {
        expect.assertions(1);

        expect(isBareCompact({ command: "compact", query: "please", wholeDraft: true })).toBe(false);
    });

    it("leaves `/compact` inside a longer message to be sent as written", () => {
        expect.assertions(1);

        expect(isBareCompact({ command: "compact", query: "", wholeDraft: false })).toBe(false);
    });

    it("is not another command", () => {
        expect.assertions(2);

        expect(isBareCompact({ command: "model", query: "", wholeDraft: true })).toBe(false);
        expect(isBareCompact({ command: undefined, query: "", wholeDraft: true })).toBe(false);
    });
});

describe(isBareCommand, () => {
    it("runs `/clear` alone", () => {
        expect.assertions(1);

        expect(isBareCommand({ command: "clear", query: "", wholeDraft: true }, "clear")).toBe(true);
    });

    it("leaves `/clear` with text after it to be sent as a message", () => {
        expect.assertions(1);

        expect(isBareCommand({ command: "clear", query: "please", wholeDraft: true }, "clear")).toBe(false);
    });

    it("leaves `/clear` inside a longer message to be sent as written", () => {
        expect.assertions(1);

        expect(isBareCommand({ command: "clear", query: "", wholeDraft: false }, "clear")).toBe(false);
    });

    it("does not treat `/compact` as `/clear`", () => {
        expect.assertions(1);

        expect(isBareCommand({ command: "compact", query: "", wholeDraft: true }, "clear")).toBe(false);
    });
});

describe(isWholeDraft, () => {
    it("is the whole draft for a bare or partial command, around blank space", () => {
        expect.assertions(3);

        expect(isWholeDraft("/clear", 0, 6)).toBe(true);
        expect(isWholeDraft("  /c  ", 2, 4)).toBe(false);
        expect(isWholeDraft("/c  ", 0, 2)).toBe(true);
    });

    it("is not the whole draft with other text before or after the command", () => {
        expect.assertions(2);

        expect(isWholeDraft("please /c", 7, 9)).toBe(false);
        expect(isWholeDraft("/cl more", 0, 3)).toBe(false);
    });
});

describe(clearedCommandRange, () => {
    const at = (text: string, wholeDraft: boolean, to = 7, threadId: string | undefined = "thread-1") => {
        return { match: { command: undefined, from: 1, query: "", startOffset: 0, text, to, wholeDraft }, threadId };
    };
    const now = (text: string, wholeDraft: boolean, to = 7, threadId: string | undefined = "thread-1", draft = text) => {
        return { ...at(text, wholeDraft, to, threadId), draft };
    };

    it("removes the command where the menu ran it, while the same chat's draft is still that text", () => {
        expect.assertions(1);

        expect(clearedCommandRange(at("/c", true), now("/c", true))).toStrictEqual({ from: 1, to: 7 });
    });

    it("leaves the draft alone once the person typed more, replaced it, or moved to another chat while the reset was written", () => {
        expect.assertions(7);

        expect(clearedCommandRange(at("/c", true), now("/cl", true))).toBeNull();
        // The same command, query and range, but other text: `/c` was replaced with `/m`.
        expect(clearedCommandRange(at("/c", true), now("/m", true))).toBeNull();
        expect(clearedCommandRange(at("/c", true), now("/c", false))).toBeNull();
        expect(clearedCommandRange(at("/c", true), now("/c", true, 9))).toBeNull();
        // Another chat whose draft happens to be the same text.
        expect(clearedCommandRange(at("/c", true), now("/c", true, 7, "thread-2"))).toBeNull();
        // The editor holds an edit the menu has not been told of yet.
        expect(clearedCommandRange(at("/c", true), now("/c", true, 7, "thread-1", "/cx"))).toBeNull();
        expect(clearedCommandRange(at("/c", true), { draft: "/c", match: null, threadId: "thread-1" })).toBeNull();
    });
});

describe(isPrefixOfCommand, () => {
    it("is the start of the command, and nothing else", () => {
        expect.assertions(4);

        expect(isPrefixOfCommand("/", "clear")).toBe(true);
        expect(isPrefixOfCommand("/cle", "clear")).toBe(true);
        expect(isPrefixOfCommand("/m", "clear")).toBe(false);
        expect(isPrefixOfCommand("/co", "clear")).toBe(false);
    });
});
