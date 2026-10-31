import { describe, expect, it } from "vitest";

import {
    ASIDE_CONTEXT_CHARS,
    ASIDE_LIVE_REPLY_CHARS,
    buildAsidePrompt,
    classifyAsideFailure,
    fitAsideRows,
    formatAsideMessage,
    liveReplyTail,
    signAsideAnswer,
    verifyAsideAnswer,
} from "./aside";

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

describe("liveReplyTail", () => {
    it("joins the newest chunks in reading order", () => {
        expect(liveReplyTail([{ text: "c" }, { text: "b" }, { text: "a" }])).toBe("abc");
    });

    it("stops at a speaker or steer marker, keeping the marker's own text", () => {
        expect(liveReplyTail([{ text: "new " }, { restart: true, text: "after steer " }, { text: "before steer" }])).toBe("after steer new ");
        expect(liveReplyTail([{ text: "two" }, { speaker: { name: "A", skillId: "s" }, text: "one " }, { text: "earlier speaker" }])).toBe("one two");
    });

    it("reads no more than the tail it needs", () => {
        const chunks = Array.from({ length: 1000 }, (_, index) => {
            return { text: `${String(index).padStart(4, "0")}${"x".repeat(96)}` };
        });
        const tail = liveReplyTail(chunks)!;

        expect(tail.length).toBeGreaterThanOrEqual(ASIDE_LIVE_REPLY_CHARS);
        expect(tail.length).toBeLessThan(ASIDE_LIVE_REPLY_CHARS + 200);
        expect(tail.startsWith("00")).toBe(true);
    });

    it("answers nothing for no text", () => {
        expect(liveReplyTail([])).toBeUndefined();
        expect(liveReplyTail([{ text: "" }])).toBeUndefined();
    });
});

describe("the answer token", () => {
    const claim = { answer: "It means safe to repeat.", question: "What is idempotent?", threadId: "t1", userId: "u1" };
    const SECRET = "k".repeat(32);

    it("verifies the exact claim it signed", async () => {
        expect(await verifyAsideAnswer(claim, await signAsideAnswer(claim, SECRET), SECRET)).toBe(true);
    });

    it.each([
        ["answer", { answer: "Something else." }],
        ["question", { question: "Another?" }],
        ["thread", { threadId: "t2" }],
        ["user", { userId: "u2" }],
    ])("refuses a changed %s", async (_name, change) => {
        expect(await verifyAsideAnswer({ ...claim, ...change }, await signAsideAnswer(claim, SECRET), SECRET)).toBe(false);
    });

    it("cannot be moved between the question and the answer by a newline", async () => {
        const token = await signAsideAnswer({ ...claim, answer: "b", question: "a\nb" }, SECRET);

        expect(await verifyAsideAnswer({ ...claim, answer: "a\nb", question: "b" }, token, SECRET)).toBe(false);
    });

    it("refuses a token signed under another secret, and signs nothing with no secret", async () => {
        expect(await verifyAsideAnswer(claim, await signAsideAnswer(claim, SECRET), "z".repeat(32))).toBe(false);
        await expect(signAsideAnswer(claim, "")).rejects.toThrow();
        expect(await verifyAsideAnswer(claim, await signAsideAnswer(claim, SECRET), "")).toBe(false);
    });
});

describe("classifyAsideFailure", () => {
    it("reads the gateway's status off the error or the one it wraps", () => {
        expect(classifyAsideFailure(Object.assign(new Error("x"), { statusCode: 402 }))).toBe("credits");
        expect(classifyAsideFailure(Object.assign(new Error("x"), { statusCode: 429 }))).toBe("rate-limited");
        expect(classifyAsideFailure(Object.assign(new Error("x"), { lastError: { statusCode: 402 } }))).toBe("credits");
        expect(classifyAsideFailure({ cause: { cause: { statusCode: 429 } } })).toBe("rate-limited");
    });

    it("calls everything else other", () => {
        expect(classifyAsideFailure(new Error("boom"))).toBe("other");
        expect(classifyAsideFailure(Object.assign(new Error("x"), { statusCode: 500 }))).toBe("other");
        expect(classifyAsideFailure("nope")).toBe("other");
    });
});
