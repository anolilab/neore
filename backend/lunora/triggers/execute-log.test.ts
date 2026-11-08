import { describe, expect, it } from "vitest";

import { promptForLog } from "./execute";

describe("promptForLog", () => {
    it("logs a whitespace-only prompt, which the agent accepts", () => {
        expect(promptForLog(" ".repeat(3))).toBe(" ".repeat(3));
    });

    it("refuses a prompt that is only hidden characters, as the headless run does", () => {
        expect(promptForLog("\u{E0041}\u{202E}")).toBeUndefined();
    });

    it("logs visible text with its hidden characters removed", () => {
        expect(promptForLog("a\u{202E}b")).toBe("ab");
    });
});
