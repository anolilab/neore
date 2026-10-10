import { describe, expect, it } from "vitest";

import { buildPromptHistoryEntries, isStillRecalled, navigatePromptHistory } from "./prompt-history";

describe(buildPromptHistoryEntries, () => {
    it("returns user messages newest first, skipping assistant and blank ones", () => {
        expect(
            buildPromptHistoryEntries([
                { role: "user", text: "first" },
                { role: "assistant", text: "reply" },
                { role: "user", text: "  " },
                { parts: [{ text: "second", type: "text" }], role: "user" },
            ]),
        ).toStrictEqual(["second", "first"]);
    });

    it("collapses consecutive duplicates only", () => {
        expect(
            buildPromptHistoryEntries([
                { role: "user", text: "a" },
                { role: "user", text: "b" },
                { role: "user", text: "b" },
                { role: "user", text: "a" },
            ]),
        ).toStrictEqual(["a", "b", "a"]);
    });
});

describe(navigatePromptHistory, () => {
    const entries = ["newest", "older", "oldest"];

    it("saves the draft on the first ArrowUp and walks back", () => {
        const first = navigatePromptHistory(null, "up", entries, "my draft");

        expect(first).toStrictEqual({ state: { draft: "my draft", index: 0 }, text: "newest" });

        const second = navigatePromptHistory(first!.state, "up", entries, "newest");

        expect(second).toStrictEqual({ state: { draft: "my draft", index: 1 }, text: "older" });
    });

    it("does not consume ArrowUp past the oldest entry or with no history", () => {
        expect(navigatePromptHistory({ draft: "", index: 2 }, "up", entries, "oldest")).toBeNull();
        expect(navigatePromptHistory(null, "up", [], "")).toBeNull();
    });

    it("walks forward and restores the draft after the newest entry", () => {
        expect(navigatePromptHistory({ draft: "d", index: 1 }, "down", entries, "older")).toStrictEqual({ state: { draft: "d", index: 0 }, text: "newest" });
        expect(navigatePromptHistory({ draft: "d", index: 0 }, "down", entries, "newest")).toStrictEqual({ state: null, text: "d" });
    });

    it("ignores ArrowDown and Escape when not navigating", () => {
        expect(navigatePromptHistory(null, "down", entries, "x")).toBeNull();
        expect(navigatePromptHistory(null, "escape", entries, "x")).toBeNull();
    });

    it("restores the draft on Escape from any depth", () => {
        expect(navigatePromptHistory({ draft: "keep me", index: 2 }, "escape", entries, "oldest")).toStrictEqual({ state: null, text: "keep me" });
    });
});

describe(isStillRecalled, () => {
    it("is true only while the text equals the recalled entry", () => {
        expect(isStillRecalled({ draft: "", index: 1 }, ["a", "b"], "b")).toBe(true);
        expect(isStillRecalled({ draft: "", index: 1 }, ["a", "b"], "b!")).toBe(false);
        expect(isStillRecalled(null, ["a"], "a")).toBe(false);
    });

    it("tolerates the editor's whitespace round trip", () => {
        expect(isStillRecalled({ draft: "", index: 0 }, ["one\n\ntwo"], "one\ntwo\n")).toBe(true);
    });
});
