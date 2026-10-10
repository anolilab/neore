import { describe, expect, it } from "vitest";

import { getSkillFormDefaults, parseTags, slugifySkillName, toSkillPayload, validateSkillForm } from "./skill-form";

const valid = {
    ...getSkillFormDefaults(),
    description: "Reviews code",
    instructions: "Review {{language}} code",
    name: "Code reviewer",
    slug: "code-reviewer",
};

describe(validateSkillForm, () => {
    it("accepts a complete form", () => {
        expect(validateSkillForm(valid)).toStrictEqual({});
    });

    it("requires name, slug, description and instructions", () => {
        expect(validateSkillForm(getSkillFormDefaults())).toStrictEqual({
            description: "descriptionRequired",
            instructions: "instructionsRequired",
            name: "nameRequired",
            slug: "slugRequired",
        });
    });

    it.each([
        ["Bad Slug", "slugFormat"],
        ["double--hyphen", "slugFormat"],
        ["-leading", "slugFormat"],
        ["admin", "slugReserved"],
        ["a".repeat(65), "slugTooLong"],
    ])("rejects slug %s", (slug, expected) => {
        expect(validateSkillForm({ ...valid, slug }).slug).toBe(expected);
    });

    it("rejects a tool that is both added and disabled", () => {
        expect(validateSkillForm({ ...valid, additionalTools: ["webSearch"], disabledTools: ["webSearch"] }).disabledTools).toBe("toolConflict");
    });
});

describe(slugifySkillName, () => {
    it("turns a name into a valid slug", () => {
        expect(slugifySkillName("  Code Reviewer — Pro! ")).toBe("code-reviewer-pro");
        expect(slugifySkillName("!!!")).toBe("");
    });
});

describe(parseTags, () => {
    it("splits, trims, lowercases and dedupes", () => {
        expect(parseTags("Foo, bar,,foo\nBaz ")).toStrictEqual(["foo", "bar", "baz"]);
    });
});

describe(toSkillPayload, () => {
    it("keeps config settings the editor does not show", () => {
        const payload = toSkillPayload({ ...valid, additionalTools: ["webSearch"] }, { reasoningEffort: 2, searchMode: "web" });

        expect(payload.config).toStrictEqual({ additionalTools: ["webSearch"], reasoningEffort: 2, searchMode: "web" });
    });

    it("omits empty optional fields", () => {
        const payload = toSkillPayload(valid);

        expect(payload.config).toStrictEqual({});
        expect(payload.category).toBeUndefined();
        expect(payload.tags).toStrictEqual([]);
    });

    it("sends a trimmed voice, and drops a blank one", () => {
        expect(toSkillPayload({ ...valid, voice: "  de-DE " }).config).toStrictEqual({ voice: "de-DE" });
        expect(toSkillPayload({ ...valid, voice: " ".repeat(3) }).config).toStrictEqual({});
    });
});

describe("skill voice", () => {
    it("reads the stored voice into the form", () => {
        expect(getSkillFormDefaults({ config: { voice: "Samantha" }, description: "d", instructions: "i", name: "n", slug: "s" }).voice).toBe("Samantha");
        expect(getSkillFormDefaults().voice).toBe("");
    });

    it("rejects an overlong voice", () => {
        expect(validateSkillForm({ ...valid, voice: "x".repeat(201) })).toStrictEqual({ voice: "voiceTooLong" });
    });
});
