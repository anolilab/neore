import { describe, expect, it } from "vitest";

import { numberDiffLines, parseDiffLines } from "./diff";

describe("parseDiffLines", () => {
    it("tags each line of a patch", () => {
        const patch = ["@@ -1,3 +1,3 @@ function a()", " keep", "-old", "+new", String.raw`\ No newline at end of file`].join("\n");

        expect(parseDiffLines(patch).map((line) => line.kind)).toEqual(["hunk", "context", "remove", "add", "meta"]);
    });

    it("keeps the text as it came, markup and all", () => {
        expect(parseDiffLines("+<img src=x onerror=alert(1)>")).toEqual([{ kind: "add", text: "+<img src=x onerror=alert(1)>" }]);
    });

    it("reads a removed line that starts with dashes as a removal, not a header", () => {
        expect(parseDiffLines("--- a/file")[0]?.kind).toBe("remove");
    });

    it("does not turn the patch's final newline into a line", () => {
        expect(parseDiffLines("+a\n")).toEqual([{ kind: "add", text: "+a" }]);
    });

    it("answers one empty line for an empty patch", () => {
        expect(parseDiffLines("")).toEqual([{ kind: "context", text: "" }]);
    });
});

describe("numberDiffLines", () => {
    const patch = [
        "@@ -10,4 +10,5 @@ fn",
        " keep",
        "-old",
        "+new one",
        "+new two",
        " tail",
        String.raw`\ No newline at end of file`,
        "@@ -40 +41,2 @@",
        " a",
        "+b",
    ].join("\n");
    const numbers = numberDiffLines(patch).map((line) => [line.kind, line.oldLine, line.newLine]);

    it("counts both sides from each hunk header", () => {
        expect(numbers).toEqual([
            ["hunk", null, null],
            ["context", 10, 10],
            ["remove", 11, null],
            ["add", null, 11],
            ["add", null, 12],
            ["context", 12, 13],
            ["meta", null, null],
            ["hunk", null, null],
            ["context", 40, 41],
            ["add", null, 42],
        ]);
    });

    it("numbers nothing before a first hunk header, and not the patch's empty trailing line", () => {
        expect(numberDiffLines("+stray").map((line) => [line.oldLine, line.newLine])).toEqual([[null, null]]);
        expect(numberDiffLines("@@ -1 +1 @@\n+a\n").map((line) => [line.oldLine, line.newLine])).toEqual([
            [null, null],
            [null, 1],
            [null, null],
        ]);
    });

    it("does not number a line of content that looks like a header", () => {
        expect(numberDiffLines("@@ -1 +1 @@\n+@@ -5 +5 @@").map((line) => line.newLine)).toEqual([null, 1]);
    });
});
