import { describe, expect, it } from "vitest";

import { classifyDiffLine, diffFiles, parseDiff } from "./diff-lines";

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "diff --git a/README.md b/README.md",
    "new file mode 100644",
    "",
].join("\n");

describe("parseDiff", () => {
    it("classifies every line of a unified diff", () => {
        expect(parseDiff(DIFF).map((line) => line.kind)).toEqual(["file", "meta", "meta", "meta", "hunk", "context", "removed", "added", "file", "meta"]);
    });

    it("does not mistake the ---/+++ file headers for changes", () => {
        expect(classifyDiffLine("--- a/x")).toBe("meta");
        expect(classifyDiffLine("+++ b/x")).toBe("meta");
        expect(classifyDiffLine("---removed dashes")).toBe("removed");
    });
});

describe("diffFiles", () => {
    it("lists the touched files", () => {
        expect(diffFiles(DIFF)).toEqual(["src/a.ts", "README.md"]);
    });
});
