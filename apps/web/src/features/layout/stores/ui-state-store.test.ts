import { describe, expect, it } from "vitest";

import { defaultKeyboardShortcuts } from "./ui-state-store";

describe("default keyboard shortcuts", () => {
    it("carry no binding that nothing registers", () => {
        for (const key of ["archiveThread", "createBranch", "deleteThread", "pinThread", "search"]) {
            expect(defaultKeyboardShortcuts).not.toHaveProperty(key);
        }
    });
});
