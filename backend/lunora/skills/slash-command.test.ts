import { describe, expect, it } from "vitest";

import type { SkillModelCandidate } from "./slash-command";
import { findSkillCommand, parseSkillCommand, resolveReasoningEffort, resolveSkillModel } from "./slash-command";

describe(parseSkillCommand, () => {
    it("reads the slug and the arguments", () => {
        expect(parseSkillCommand("/code-review  src/app.ts please ")).toStrictEqual({ rawArgs: "src/app.ts please", slug: "code-review" });
        expect(parseSkillCommand("/summarise")).toStrictEqual({ rawArgs: "", slug: "summarise" });
        expect(parseSkillCommand("  /summarise\nline two")).toStrictEqual({ rawArgs: "line two", slug: "summarise" });
    });

    it.each([
        ["no slash", "code-review this"],
        ["slash mid-sentence", "please /code-review this"],
        ["a path", "/usr/bin/env node"],
        ["uppercase", "/Code-Review"],
        ["double hyphen", "/code--review"],
        ["bare slash", "/"],
        ["too long", `/${"a".repeat(65)}`],
    ])("ignores %s", (_label, text) => {
        expect(parseSkillCommand(text)).toBeNull();
    });
});

describe(resolveSkillModel, () => {
    const models: Record<string, SkillModelCandidate> = {
        "disabled-model": { enabled: false, mode: "text", provider: "openai" },
        "external-model": { mode: "text", provider: "external" },
        "image-model": { mode: "image", provider: "fal" },
        "text-model": { mode: "text", provider: "openai" },
    };
    const lookup = (id: string) => models[id];

    it("uses a skill's preferred platform text model", () => {
        expect(resolveSkillModel("requested", "text-model", lookup, false)).toBe("text-model");
    });

    it("keeps the requested model otherwise", () => {
        expect(resolveSkillModel("requested", undefined, lookup, false)).toBe("requested");
        expect(resolveSkillModel("requested", "text-model", lookup, true)).toBe("requested");
        expect(resolveSkillModel("requested", "custom:provider/model", lookup, false)).toBe("requested");

        for (const id of ["disabled-model", "external-model", "image-model", "unknown-model"]) {
            expect(resolveSkillModel("requested", id, lookup, false)).toBe("requested");
        }
    });
});

describe(findSkillCommand, () => {
    // What `/chat/start` saves: attachment text unshifted in FRONT of the typed text.
    const withAttachment = [
        { text: "[Document: notes.md]\n\n/not-a-command inside the file", type: "text" },
        { text: "/code-review focus on auth", type: "text" },
        { image: "https://example.test/a.png", type: "image" },
    ];
    const concatenated = withAttachment.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join(" ");

    it("finds the command in the typed part when an attachment comes first", () => {
        expect(parseSkillCommand(concatenated)).toBeNull();
        expect(findSkillCommand(undefined, withAttachment, concatenated)).toStrictEqual({ rawArgs: "focus on auth", slug: "code-review" });
    });

    it("trusts the raw composer text over the stored parts", () => {
        expect(findSkillCommand("/summarise now", withAttachment, concatenated)).toStrictEqual({ rawArgs: "now", slug: "summarise" });
        expect(findSkillCommand("just a question", withAttachment, concatenated)).toBeNull();
    });

    it("falls back to string content and then to the text", () => {
        expect(findSkillCommand(undefined, "/summarise", "")).toStrictEqual({ rawArgs: "", slug: "summarise" });
        expect(findSkillCommand(undefined, undefined, "/summarise")).toStrictEqual({ rawArgs: "", slug: "summarise" });
        expect(findSkillCommand(undefined, [{ text: "hello", type: "text" }], "hello")).toBeNull();
    });
});

describe(resolveReasoningEffort, () => {
    it("keeps the existing rule without a skill", () => {
        expect(resolveReasoningEffort({ messageEffort: 1, threadEffort: 3 })).toBe(3);
        expect(resolveReasoningEffort({ messageEffort: 1 })).toBe(1);
        expect(resolveReasoningEffort({})).toBeUndefined();
    });

    it("applies the skill default over the thread's stored setting", () => {
        expect(resolveReasoningEffort({ skillEffort: 4, threadEffort: 1 })).toBe(4);
        expect(resolveReasoningEffort({ skillEffort: 0, threadEffort: 3 })).toBe(0);
    });

    it("lets the user's explicit per-message choice beat the skill", () => {
        expect(resolveReasoningEffort({ messageEffort: 1, skillEffort: 4, threadEffort: 2 })).toBe(1);
    });
});
