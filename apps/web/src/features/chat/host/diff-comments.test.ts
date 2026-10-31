import { describe, expect, it } from "vitest";

import type { DiffComment } from "./diff-comments";
import { composeDiffComments, describeRange, MAX_COMMENT_MESSAGE_BYTES, MAX_COMMENT_MESSAGE_CHARS, parsePatchFiles, rangeOf, sameHunk } from "./diff-comments";

const PATCH = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,3 +3,4 @@",
    " keep one",
    "-old line",
    "+new line",
    "+another new line",
    " keep two",
    "--- /dev/null",
    "+++ b/docs/b.md",
    "@@ -0,0 +1,2 @@",
    "+# Title",
    "+text",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
    "",
].join("\n");

const comment = (fields: Partial<DiffComment> & { text: string }): DiffComment => {
    return { id: "c1", messageId: "m1", path: "src/a.ts", ...fields };
};

const lineComment = (quoted: string[], text = "please check", path = "src/a.ts"): DiffComment =>
    comment({ path, range: { from: 4, hunk: "@@ -3,3 +3,4 @@", lineIds: [], quoted, side: "new", to: 4 + quoted.length - 1 }, text });

const OMITTED = /… \d+ more diff lines not shown/u;

describe("parsePatchFiles", () => {
    const files = parsePatchFiles(PATCH);

    it("names each file by its new path, and a deleted one by its old path", () => {
        expect(files.map((file) => file.path)).toEqual(["src/a.ts", "docs/b.md", "gone.txt"]);
    });

    it("numbers added and unchanged lines in the new file and removed lines in the old one", () => {
        const [first] = files;
        const selectable = first?.lines.filter((line) => line.selectable) ?? [];

        expect(selectable.map((line) => [line.text, line.oldNumber, line.newNumber])).toEqual([
            [" keep one", 3, 3],
            ["-old line", 4, undefined],
            ["+new line", undefined, 4],
            ["+another new line", undefined, 5],
            [" keep two", 5, 6],
        ]);
    });

    it("leaves file headers and hunk headers out of what can be commented on", () => {
        const [first] = files;

        expect(first?.lines.filter((line) => !line.selectable).map((line) => line.kind)).toEqual(["hunk"]);
    });
});

describe("rangeOf", () => {
    it("takes the lines, their hunk and the numbers of the first and last", () => {
        const selectable = parsePatchFiles(PATCH)[0]?.lines.filter((line) => line.selectable) ?? [];
        const lines = selectable.slice(2, 4);

        expect(rangeOf(lines)).toEqual({
            from: 4,
            hunk: "@@ -3,3 +3,4 @@",
            lineIds: ["line-5", "line-6"],
            quoted: ["+new line", "+another new line"],
            side: "new",
            to: 5,
        });
        expect(rangeOf([])).toBeUndefined();
    });

    it("counts a selection that runs from a removal to an addition on the new side only", () => {
        const [file] = parsePatchFiles(PATCH);
        const lines = file?.lines.filter((line) => line.selectable).slice(1, 4) ?? [];

        // -old line (old 4), +new line (new 4), +another new line (new 5): the removal has no new number and is quoted, not counted.
        expect(rangeOf(lines)).toMatchObject({ from: 4, quoted: ["-old line", "+new line", "+another new line"], side: "new", to: 5 });
    });

    it("does not mix an old number into a new-side range when the selection ends on a removal", () => {
        const [file] = parsePatchFiles(PATCH);
        const lines = file?.lines.filter((line) => line.selectable).slice(0, 2) ?? [];

        // keep one (new 3), -old line (old 4): only the unchanged line has a number on the new side.
        expect(rangeOf(lines)).toMatchObject({ from: 3, quoted: [" keep one", "-old line"], side: "new", to: 3 });
    });

    it("counts a removed line on the old side and says so", () => {
        const removed = parsePatchFiles(PATCH)[2]?.lines.filter((line) => line.selectable) ?? [];
        const range = rangeOf(removed);

        expect(range).toMatchObject({ from: 1, side: "old", to: 1 });
        expect(describeRange(range as never, "removed")).toBe("1 (removed)");
        expect(describeRange({ from: 4, side: "new", to: 6 }, "removed")).toBe("4-6");
    });

    it("says a removed line in the word it is given, so a label can be translated", () => {
        expect(describeRange({ from: 1, side: "old", to: 3 }, "entfernt")).toBe("1-3 (entfernt)");
    });
});

describe("sameHunk", () => {
    const TWO_HUNKS = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,2 @@", " one", "+two", "@@ -20,1 +20,2 @@", " twenty", "+twenty-one", ""].join("\n");

    it("holds for lines under one hunk header and fails across two", () => {
        const [file] = parsePatchFiles(TWO_HUNKS);
        const selectable =
            file?.lines
                .map((line, index) => {
                    return { index, line };
                })
                .filter(({ line }) => line.selectable) ?? [];
        const [one, two, twenty] = selectable.map(({ index }) => index) as [number, number, number];

        expect(sameHunk(file as never, one, two)).toBe(true);
        expect(sameHunk(file as never, two, twenty)).toBe(false);
        expect(sameHunk(file as never, twenty, one)).toBe(false);
    });
});

describe("composeDiffComments", () => {
    it("quotes the path, the lines and the hunk of each comment, then what was said", () => {
        const result = composeDiffComments([
            lineComment(["+new line", "+another new line"], "Why two lines?"),
            comment({
                path: "docs/b.md",
                range: { from: 1, hunk: "@@ -0,0 +1,2 @@", lineIds: ["line-0"], quoted: ["+# Title"], side: "new", to: 1 },
                text: "Rename it",
            }),
        ]);

        expect(result).toMatchObject({ ok: true, truncated: false });

        const { text } = result as { text: string };

        expect(text).toContain("2 comments");
        expect(text).toContain("Comment 1 on src/a.ts, lines 4-5:\n```diff\n@@ -3,3 +3,4 @@\n+new line\n+another new line\n```\nWhy two lines?");
        expect(text).toContain("Comment 2 on docs/b.md, lines 1:\n```diff\n@@ -0,0 +1,2 @@\n+# Title\n```\nRename it");
    });

    it("sends a comment on a whole file with no quote", () => {
        const result = composeDiffComments([comment({ path: "big.ts", text: "Split this file" })]);

        expect(result).toEqual({
            ok: true,
            text: "I reviewed the changes you made and have 1 comment on the diff. Please address it.\n\nComment 1 on big.ts (the whole file):\nSplit this file",
            truncated: false,
        });
    });

    it("fences a quote that holds backticks with a longer fence", () => {
        const result = composeDiffComments([lineComment(["+```ts", "+let x", "+```"])]);

        expect((result as { text: string }).text).toContain("````diff\n@@ -3,3 +3,4 @@\n+```ts");
    });

    it("refuses nothing to send", () => {
        expect(composeDiffComments([])).toEqual({ ok: false, reason: "empty" });
    });

    describe("over the size cap", () => {
        const bigQuote = (count: number) => Array.from({ length: count }, (_, index) => `+line ${String(index)} ${"x".repeat(60)}`);
        const within = (text: string) => {
            expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_MESSAGE_CHARS);
            expect(new TextEncoder().encode(JSON.stringify(text)).length).toBeLessThanOrEqual(MAX_COMMENT_MESSAGE_BYTES);
        };

        it("cuts the quoted lines, keeps every comment whole and says so", () => {
            const comments = [lineComment(bigQuote(2000), "first comment, in full"), lineComment(bigQuote(2000), "second comment, in full")];
            const result = composeDiffComments(comments);

            expect(result.ok).toBe(true);

            const { text, truncated } = result as { text: string; truncated: boolean };

            within(text);
            expect(truncated).toBe(true);
            expect(text).toContain("first comment, in full");
            expect(text).toContain("second comment, in full");
            expect(text).toMatch(OMITTED);
            expect(text).toContain("shortened to fit the size limit");
            expect(text).toContain("+line 0 ");
        });

        it("shares the room: a short quote stays whole beside a huge one", () => {
            const result = composeDiffComments([lineComment(["+short one"], "small"), lineComment(bigQuote(3000), "big")]);
            const { text } = result as { text: string };

            within(text);
            expect(text).toContain("+short one\n```");
            expect(text.match(/more diff lines not shown/gu)).toHaveLength(1);
        });

        it("counts multibyte text and escapes by what they weigh on the wire", () => {
            const wide = Array.from({ length: 4000 }, () => `+${"日本語".repeat(10)}"`);
            const result = composeDiffComments([lineComment(wide)]);

            expect(result.ok).toBe(true);
            within((result as { text: string }).text);
        });

        it("refuses, rather than trimming a comment, when the comments alone do not fit", () => {
            const comments = Array.from({ length: 40 }, (_, index) => comment({ id: `c${String(index)}`, text: "y".repeat(1000) }));

            expect(composeDiffComments(comments)).toEqual({ ok: false, reason: "too_long" });
        });
    });
});
