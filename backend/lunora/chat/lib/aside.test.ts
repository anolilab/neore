import { describe, expect, it } from "vitest";

import { ASIDE_CONTEXT_CHARS, buildAsidePrompt, fitAsideRows, formatAsideMessage } from "./aside";

describe("fitAsideRows", () => {
    it("keeps the newest rows that fit, in reading order", () => {
        const rows = Array.from({ length: 10 }, (_, index) => {
            return { role: index % 2 === 0 ? ("user" as const) : ("assistant" as const), text: `${String(index)}${"x".repeat(5999)}` };
        });
        const fitted = fitAsideRows(rows);

        expect(fitted.length).toBeLessThan(rows.length);
        expect(fitted.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(ASIDE_CONTEXT_CHARS);
        expect(fitted.at(-1)?.text.startsWith("9")).toBe(true);
        expect(fitted.map((row) => row.text[0])).toStrictEqual(fitted.map((row) => row.text[0]).toSorted((a, b) => String(a).localeCompare(String(b))));
    });

    it("drops empty rows and cuts one very long row", () => {
        const fitted = fitAsideRows([
            { role: "user", text: " ".repeat(3) },
            { role: "user", text: "y".repeat(50_000) },
        ]);

        expect(fitted).toHaveLength(1);
        expect(fitted[0]!.text.length).toBeLessThan(7000);
    });
});

describe("buildAsidePrompt", () => {
    it("carries the question alone when there is no context", () => {
        expect(buildAsidePrompt("What is X?", [])).toBe("Side question:\nWhat is X?");
    });

    it("keeps the end of a long reply that is still being written", () => {
        const prompt = buildAsidePrompt("What is X?", [], `${"a".repeat(20_000)}THE END`);

        expect(prompt).toContain("THE END [reply still being written]");
        expect(prompt.length).toBeLessThan(9000);
    });

    it("wraps the conversation as JSON, marks a running reply, and puts the question last", () => {
        const prompt = buildAsidePrompt("What is X?", [{ role: "user", text: 'say "hi"' }], "Partly writ");

        expect(prompt).toContain(String.raw`"text":"say \"hi\""`);
        expect(prompt).toContain("[reply still being written]");
        expect(prompt.endsWith("Side question:\nWhat is X?")).toBe(true);
    });
});

describe("formatAsideMessage", () => {
    it("quotes every line of the question, then the answer", () => {
        expect(formatAsideMessage("a\nb", " The answer. ")).toBe("**Side question**\n\n> a\n> b\n\nThe answer.");
    });
});
