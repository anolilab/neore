import { describe, expect, it } from "vitest";

import { parseDiffLines } from "./diff";

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
