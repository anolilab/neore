import { describe, expect, it } from "vitest";

import { buildPromptHistoryEntries, buildPromptHistoryMarks, isStillRecalled, navigatePromptHistory } from "./prompt-history";

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

describe(buildPromptHistoryMarks, () => {
    it("keeps the mark of each prompt the server saved as not typed, a marked copy winning over an unmarked one", () => {
        const marked = {
            parts: [{ providerMetadata: { neore: { notTyped: { draft: "sharedPrompt" } } }, text: "a colleague's prompt", type: "text" }],
            role: "user",
        };

        expect(
            buildPromptHistoryMarks(
                [
                    { role: "user", text: "a colleague's prompt", userId: "owner-1" },
                    marked,
                    { role: "user", text: "a colleague's prompt", userId: "owner-1" },
                    { parts: [{ text: "mine", type: "text" }], role: "user", userId: "owner-1" },
                    { ...marked, role: "assistant" },
                ],
                "owner-1",
            ),
        ).toStrictEqual(new Map([["a colleague's prompt", "sharedPrompt"]]));
    });

    it("marks a collaborator's message in a shared chat, and none of the viewer's own", () => {
        expect(
            buildPromptHistoryMarks(
                [
                    { role: "user", text: "theirs", userId: "collaborator-1" },
                    { role: "user", text: "mine", userId: "owner-1" },
                    { role: "user", status: "pending", text: "just sent" },
                    { role: "user", status: "success", text: "saved naming nobody" },
                    { role: "assistant", text: "a reply", userId: "collaborator-1" },
                ],
                "owner-1",
            ),
        ).toStrictEqual(
            new Map([
                ["saved naming nobody", "collaborator"],
                ["theirs", "collaborator"],
            ]),
        );
        // A saved mark still wins over `collaborator`, whichever comes first.
        expect(
            buildPromptHistoryMarks(
                [
                    { role: "user", text: "twice", userId: "collaborator-1" },
                    {
                        parts: [{ providerMetadata: { neore: { notTyped: { impersonated: true } } }, text: "twice", type: "text" }],
                        role: "user",
                        userId: "owner-1",
                    },
                    { role: "user", text: "twice", userId: "collaborator-1" },
                ],
                "owner-1",
            ),
        ).toStrictEqual(new Map([["twice", "impersonated"]]));
        // Before the session is known, any saved message counts as someone else's.
        expect(buildPromptHistoryMarks([{ role: "user", text: "mine", userId: "owner-1" }], undefined)).toStrictEqual(new Map([["mine", "collaborator"]]));
    });

    it("keeps an admin's mark on a prompt they wrote as the owner, over a draft's", () => {
        const byAdmin = (notTyped: unknown, text: string) => {
            return { parts: [{ providerMetadata: { neore: { notTyped } }, text, type: "text" }], role: "user" };
        };

        expect(
            buildPromptHistoryMarks(
                [byAdmin({ impersonated: true }, "sent as you"), byAdmin({ draft: "promptLink", impersonated: true }, "a link, as you")],
                "owner-1",
            ),
        ).toStrictEqual(
            new Map([
                ["a link, as you", "impersonated"],
                ["sent as you", "impersonated"],
            ]),
        );
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
