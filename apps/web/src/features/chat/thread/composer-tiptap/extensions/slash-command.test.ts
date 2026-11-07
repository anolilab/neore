import { describe, expect, it } from "vitest";

import { isBareCompact } from "./slash-command";

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
