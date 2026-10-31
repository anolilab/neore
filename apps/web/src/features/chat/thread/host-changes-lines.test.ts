import { describe, expect, it } from "vitest";

import { classifyPatch } from "./host-changes-lines";

describe("classifyPatch", () => {
    it("tells file headers from lines by where they sit: a removed `-- comment` is a removal inside a hunk", () => {
        const patch = ["--- a/q.sql", "+++ b/q.sql", "@@ -1,3 +1,3 @@", " select 1;", "--- drop me", "+++ keep me", " select 2;", ""].join("\n");

        expect(classifyPatch(patch).map((line) => line.kind)).toEqual(["header", "header", "hunk", "context", "remove", "add", "context"]);
    });

    it("reads the next file's headers once a hunk has used its lines", () => {
        const patch = ["--- a/a", "+++ b/a", "@@ -1 +1 @@", "-old", "+new", "--- a/b", "+++ b/b", "@@ -0,0 +1,2 @@", "+x", "+y", ""].join("\n");

        expect(classifyPatch(patch).map((line) => line.kind)).toEqual(["header", "header", "hunk", "remove", "add", "header", "header", "hunk", "add", "add"]);
    });

    it("counts a missing-newline note for neither side, and gives every line its own id", () => {
        const lines = classifyPatch(["--- /dev/null", "+++ b/n", "@@ -0,0 +1,2 @@", "+a", "+b", String.raw`\ No newline at end of file`, ""].join("\n"));

        expect(lines.map((line) => line.kind)).toEqual(["header", "header", "hunk", "add", "add", "context"]);
        expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
    });
});
