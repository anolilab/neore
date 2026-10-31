import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES, MAX_HOOKS, MAX_NAME, MAX_PROMPT, parseHooks } from "./schema";

const file = (hooks: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ hooks, version: 1, ...extra });

const accepts = (hooks: unknown[], extra: Record<string, unknown> = {}): boolean => parseHooks(file(hooks, extra)).ok;

const saved = { glob: "src/**/*.ts", id: "review", name: "Review", on: "saved", prompt: "Look at the file." };

describe("parseHooks", () => {
    it("accepts file hooks and manual hooks", () => {
        const parsed = parseHooks(file([saved, { id: "summary", name: "Summary", on: "manual", prompt: "Summarise." }]));

        expect(parsed).toMatchObject({ ok: true });
        expect(parsed.ok && parsed.hooks.map((hook) => hook.on)).toEqual(["saved", "manual"]);
    });

    it("refuses an unknown field anywhere", () => {
        expect(accepts([saved], { extra: 1 })).toBe(false);
        expect(accepts([{ ...saved, command: "rm -rf /" }])).toBe(false);
        expect(accepts([{ glob: "*", id: "m", name: "M", on: "manual", prompt: "x" }])).toBe(false);
    });

    it("refuses another version, a missing version and text that is not JSON", () => {
        expect(parseHooks(JSON.stringify({ hooks: [], version: 2 })).ok).toBe(false);
        expect(parseHooks(JSON.stringify({ hooks: [] })).ok).toBe(false);
        expect(parseHooks("{ not json").ok).toBe(false);
        expect(parseHooks("[]").ok).toBe(false);
    });

    it("caps the prompt, the name and the number of hooks", () => {
        expect(accepts([{ ...saved, prompt: "x".repeat(MAX_PROMPT) }])).toBe(true);
        expect(accepts([{ ...saved, prompt: "x".repeat(MAX_PROMPT + 1) }])).toBe(false);
        expect(accepts([{ ...saved, name: "n".repeat(MAX_NAME + 1) }])).toBe(false);
        expect(accepts([{ ...saved, prompt: "  " }])).toBe(false);

        const many = Array.from({ length: MAX_HOOKS + 1 }, (_, index) => {
            return { ...saved, id: `hook-${String(index)}` };
        });

        expect(accepts(many.slice(0, MAX_HOOKS))).toBe(true);
        expect(accepts(many)).toBe(false);
    });

    it("refuses duplicate ids, odd ids and names that carry control characters", () => {
        expect(accepts([saved, saved])).toBe(false);
        expect(accepts([{ ...saved, id: "Has Space" }])).toBe(false);
        expect(accepts([{ ...saved, name: "line\nbreak" }])).toBe(false);
    });

    it("refuses a glob that could leave the folder", () => {
        for (const glob of ["../**", "/etc/*", "src/../../x", "C:/x", String.raw`a\b`, "!src/*", "", "a//b", "src/**x", "{a,../b}/*"]) {
            expect(accepts([{ ...saved, glob }]), glob).toBe(false);
        }
    });

    it("refuses an event that is not one of the four", () => {
        expect(accepts([{ ...saved, on: "moved" }])).toBe(false);
    });

    it("refuses a file past the byte cap without parsing it", () => {
        const parsed = parseHooks(" ".repeat(MAX_FILE_BYTES + 1));

        expect(parsed).toMatchObject({ ok: false });
    });

    describe("hidden characters", () => {
        // Each is written as a JSON escape: the character exists only after the file is parsed, as in a real hooks file.
        const hidden: Record<string, string> = {
            "a bidi embedding": String.raw`\u202a`,
            "a bidi isolate": String.raw`\u2066`,
            "a bidi isolate end": String.raw`\u2069`,
            "a bidi override": String.raw`\u202e`,
            "a byte order mark": String.raw`\ufeff`,
            "a C0 control": String.raw`\u0007`,
            "a C1 control": String.raw`\u0085`,
            "a carriage return": String.raw`\r`,
            "a DEL": String.raw`\u007f`,
            "a line separator": String.raw`\u2028`,
            "a paragraph separator": String.raw`\u2029`,
            "a soft hyphen": String.raw`\u00ad`,
            "a tag character": String.raw`\udb40\udc41`,
            "a word joiner": String.raw`\u2060`,
            "a zero width space": String.raw`\u200b`,
            "the tag block's first code point": String.raw`\udb40\udc00`,
            "the tag block's last code point": String.raw`\udb40\udc7f`,
        };
        const textOf = (field: "glob" | "name" | "prompt", character: string): string => {
            const base = { glob: "src/a", id: "h", name: "Name", on: "saved", prompt: "Look." };

            return JSON.stringify({ hooks: [{ ...base, [field]: `${base[field]}@@x` }], version: 1 }).replace("@@", () => character);
        };

        for (const [label, character] of Object.entries(hidden)) {
            for (const field of ["glob", "name", "prompt"] as const) {
                it(`refuses ${label} in a ${field}`, () => {
                    expect(parseHooks(textOf(field, character)).ok).toBe(false);
                });
            }
        }

        it("still takes a newline and a tab in a prompt, but not in a name", () => {
            expect(parseHooks(textOf("prompt", String.raw`\n\t`)).ok).toBe(true);
            expect(parseHooks(textOf("name", String.raw`\n`)).ok).toBe(false);
            expect(parseHooks(textOf("name", String.raw`\t`)).ok).toBe(false);
        });

        it("refuses them in a manual hook too", () => {
            const text = JSON.stringify({ hooks: [{ id: "m", name: "M", on: "manual", prompt: "x@@" }], version: 1 }).replace("@@", String.raw`\u202e`);

            expect(parseHooks(text).ok).toBe(false);
        });
    });
});
