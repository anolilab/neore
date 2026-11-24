import { describe, expect, it } from "vitest";

import type { ReplyGuard } from "./reply-guard";
import { createReplyGuard, LOCAL_REASONING_LIMIT_CHARS, LOCAL_REPEAT_LIMIT, LOCAL_REPEAT_MAX_BLOCK_LINES } from "./reply-guard";

/** Feeds `text` in pieces of `size` characters and returns the kind of the first stop, if any. */
const feedContent = (guard: ReplyGuard, text: string, size = text.length) => {
    for (let index = 0; index < text.length; index += size) {
        const stop = guard.pushContent(text.slice(index, index + size));

        if (stop) {
            return stop.kind;
        }
    }

    return undefined;
};

describe(createReplyGuard, () => {
    it("stops a reply that repeats one line past the limit", () => {
        expect.assertions(2);

        const guard = createReplyGuard();
        const line = "Let me try that again.\n";

        expect(feedContent(guard, line.repeat(LOCAL_REPEAT_LIMIT - 1))).toBeUndefined();
        expect(feedContent(guard, line)).toBe("repeat-loop");
    });

    it("stops a reply that repeats a block of lines past the limit", () => {
        expect.assertions(2);

        const guard = createReplyGuard();
        const block = "Step one is to open the file.\nStep two is to read it.\n";

        expect(feedContent(guard, block.repeat(LOCAL_REPEAT_LIMIT - 1))).toBeUndefined();
        expect(feedContent(guard, block)).toBe("repeat-loop");
    });

    it("finds a repeat however the tokens are split", () => {
        expect.assertions(1);

        const guard = createReplyGuard();

        expect(feedContent(guard, "Same line of text here.\n".repeat(LOCAL_REPEAT_LIMIT), 3)).toBe("repeat-loop");
    });

    it("does not stop a reply whose repeats are broken up or too short to be a loop", () => {
        expect.assertions(3);

        const guard = createReplyGuard();
        const repeated = "Keep going on this point.\n";

        // Repeats that a different line interrupts are not a loop.
        const interrupted = `${repeated.repeat(LOCAL_REPEAT_LIMIT - 1)}A different line.\n${repeated.repeat(LOCAL_REPEAT_LIMIT - 1)}`;

        expect(feedContent(guard, interrupted)).toBeUndefined();

        // Short lines repeat in real code and tables: `}` or `---` under the minimum is not a loop.
        expect(feedContent(createReplyGuard(), "}\n".repeat(LOCAL_REPEAT_LIMIT * 2))).toBeUndefined();
        expect(feedContent(createReplyGuard(), "|---|\n".repeat(LOCAL_REPEAT_LIMIT - 1))).toBeUndefined();
    });

    it("does not stop an ordinary reply, with blank lines and a repeat under the limit", () => {
        expect.assertions(1);

        const reply = [
            "# Plan",
            "",
            "- Read the config file first.",
            "- Then update the value.",
            "",
            "Run the tests.",
            "",
            "- Run the tests.",
            "- Run the tests.",
            "Done.",
        ].join("\n");

        expect(feedContent(createReplyGuard(), reply)).toBeUndefined();
    });

    it("recognises blocks up to the longest size", () => {
        expect.assertions(1);

        const guard = createReplyGuard();
        const blockLines = Array.from({ length: LOCAL_REPEAT_MAX_BLOCK_LINES }, (_, index) => `Line number ${index} of the block.`);
        const longBlock = `${blockLines.join("\n")}\n`;

        expect(feedContent(guard, longBlock.repeat(LOCAL_REPEAT_LIMIT))).toBe("repeat-loop");
    });

    it("does not treat nested lines that differ only in indentation as a repeat", () => {
        expect.assertions(1);

        // Code nested step by step: the same words at each depth are not the same line.
        const lines = Array.from({ length: LOCAL_REPEAT_LIMIT }, (_, depth) => `${" ".repeat(depth * 4)}if ready:`);
        const nested = `${lines.join("\n")}\n`;

        expect(feedContent(createReplyGuard(), nested)).toBeUndefined();
    });

    it("reports where the reply ends inside the delta that completes the repeat", () => {
        expect.assertions(1);

        const guard = createReplyGuard();
        const line = "Let me try that again.\n";
        const delta = `${line.repeat(LOCAL_REPEAT_LIMIT)}text that must not be kept`;

        expect(guard.pushContent(delta)).toStrictEqual({ keep: line.length * LOCAL_REPEAT_LIMIT, kind: "repeat-loop" });
    });

    it("stops reasoning once it passes the limit, and not before", () => {
        expect.assertions(2);

        const guard = createReplyGuard();

        expect(guard.pushReasoning("r".repeat(LOCAL_REASONING_LIMIT_CHARS))).toBeUndefined();
        expect(guard.pushReasoning("r")).toBe("reasoning-limit");
    });
});
