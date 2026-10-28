import { describe, expect, it, vi } from "vitest";

import { MAX_COMPOSE_CHARS } from "../site.js";
import { insertDictation } from "./insert.js";

const dependencies = (canTakeDraft: boolean) => {
    return { canTakeDraft: () => canTakeDraft, handOffDraft: vi.fn(), notify: vi.fn(), writeClipboard: vi.fn() };
};

describe("insertDictation", () => {
    it("puts the text in the composer as a draft", () => {
        const d = dependencies(true);

        expect(insertDictation(d, "  hello world \n")).toBe("composer");
        expect(d.handOffDraft).toHaveBeenCalledWith("hello world");
        expect(d.writeClipboard).not.toHaveBeenCalled();
        expect(d.notify).not.toHaveBeenCalled();
    });

    it("copies the text and says so when the main window cannot take it", () => {
        const d = dependencies(false);

        expect(insertDictation(d, "hello world")).toBe("clipboard");
        expect(d.writeClipboard).toHaveBeenCalledWith("hello world");
        expect(d.notify).toHaveBeenCalledWith("Dictation", expect.stringContaining("clipboard"));
        expect(d.handOffDraft).not.toHaveBeenCalled();
    });

    it("clamps what it hands over", () => {
        const d = dependencies(true);

        insertDictation(d, "x".repeat(MAX_COMPOSE_CHARS + 500));

        expect(d.handOffDraft.mock.calls[0]?.[0]).toHaveLength(MAX_COMPOSE_CHARS);
    });
});
