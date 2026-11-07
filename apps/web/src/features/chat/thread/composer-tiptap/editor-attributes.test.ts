import { describe, expect, it } from "vitest";

import { composerEditorAttributes } from "./editor-attributes";

describe("composerEditorAttributes", () => {
    it("carries no description or invalid flag by default", () => {
        const attributes = composerEditorAttributes();

        expect(attributes.dir).toBe("auto");
        expect(attributes).not.toHaveProperty("aria-describedby");
        expect(attributes).not.toHaveProperty("aria-invalid");
    });

    it("names the field when given a label", () => {
        const attributes = composerEditorAttributes({ label: "Message" });

        expect(attributes["aria-label"]).toBe("Message");
        expect(attributes["aria-multiline"]).toBe("true");
    });

    it("names the notice and flags the field invalid", () => {
        const attributes = composerEditorAttributes({ describedBy: "notice-1", invalid: true });

        expect(attributes["aria-describedby"]).toBe("notice-1");
        expect(attributes["aria-invalid"]).toBe("true");
    });
});
