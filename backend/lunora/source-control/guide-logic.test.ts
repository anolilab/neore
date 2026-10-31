import { describe, expect, it } from "vitest";

import { assembleGuide, extractJsonObject, folderMatchesRepo, guideFreshness, isMechanicalFile, parsePatchLines } from "./guide-logic";
import type { GuideFile } from "./guide-logic";

const PATCH = ["@@ -1,3 +1,4 @@", " keep", "-old line", "+new line", "+added line", " tail"].join("\n");

const file = (path: string, over: Partial<GuideFile> = {}): GuideFile => {
    return { additions: 2, deletions: 1, patch: PATCH, path, previousPath: null, status: "modified", ...over };
};

describe("parsePatchLines", () => {
    it("numbers both sides of each hunk", () => {
        const lines = parsePatchLines(PATCH);

        expect([...lines.newLines]).toEqual([1, 2, 3, 4]);
        expect([...lines.oldLines]).toEqual([1, 2, 3]);
    });

    it("reads several hunks and skips the no-newline marker", () => {
        const lines = parsePatchLines(["@@ -1,1 +1,1 @@", "-a", "+b", String.raw`\ No newline at end of file`, "@@ -10,1 +10,2 @@", " c", "+d"].join("\n"));

        expect([...lines.newLines]).toEqual([1, 10, 11]);
        expect([...lines.oldLines]).toEqual([1, 10]);
    });

    it("reads nothing from a missing patch", () => {
        expect(parsePatchLines(null).newLines.size).toBe(0);
    });
});

describe("isMechanicalFile", () => {
    it.each([
        "pnpm-lock.yaml",
        "apps/web/package-lock.json",
        "a/__snapshots__/x.test.ts.snap",
        "dist/app.min.js",
        "backend/lunora/_generated/api.ts",
        "go.sum",
    ])("%s is mechanical", (path) => {
        expect(isMechanicalFile(file(path))).toBe(true);
    });

    it("treats a rename with no edits as mechanical, an edited rename as not", () => {
        expect(isMechanicalFile(file("b.ts", { additions: 0, deletions: 0, patch: null, previousPath: "a.ts", status: "renamed" }))).toBe(true);
        expect(isMechanicalFile(file("b.ts", { previousPath: "a.ts", status: "renamed" }))).toBe(false);
    });

    it("leaves source files alone", () => {
        expect(isMechanicalFile(file("src/lock-manager.ts"))).toBe(false);
    });
});

describe("assembleGuide", () => {
    const files = [
        file("src/core.ts"),
        file("src/user.ts"),
        file("pnpm-lock.yaml"),
        file("src/skipped.ts"),
        file("src/binary.png", { patch: null, status: "added" }),
    ];

    const output = {
        proposals: [],
        stops: [
            { explanation: "The change itself", files: [{ path: "src/core.ts", ranges: [{ end: 4, side: "new", start: 2 }] }], role: "core", title: "Core" },
            { explanation: "Uses it", files: [{ path: "src/user.ts", ranges: [] }], role: "dependent", title: "Caller" },
        ],
        summary: "Adds a thing.",
    };

    it("covers every changed file: what the model skipped goes under a not covered stop", () => {
        const guide = assembleGuide(files, output, 0);
        const covered = guide.stops.flatMap((stop) => stop.files.map((entry) => entry.path)).toSorted((a, b) => a.localeCompare(b));

        expect(covered).toEqual(files.map((entry) => entry.path).toSorted((a, b) => a.localeCompare(b)));
        expect(guide.stops.at(-1)).toMatchObject({ kind: "uncovered" });
        const skipped = (guide.stops.at(-1)?.files ?? []).map((entry) => entry.path);

        expect(skipped.toSorted((a, b) => a.localeCompare(b))).toEqual(["src/binary.png", "src/skipped.ts"]);
    });

    it("orders core, then dependents, then mechanical changes, then what is not covered", () => {
        const guide = assembleGuide(files, { ...output, stops: [...output.stops].toReversed() }, 0);

        expect(guide.stops.map((stop) => stop.kind)).toEqual(["core", "dependent", "mechanical", "uncovered"]);
        expect(guide.stops[2]?.files.map((entry) => entry.path)).toEqual(["pnpm-lock.yaml"]);
    });

    it("moves a lockfile the model put in a core stop to the mechanical group", () => {
        const guide = assembleGuide(files, { ...output, stops: [{ ...output.stops[0], files: [{ path: "pnpm-lock.yaml" }, { path: "src/core.ts" }] }] }, 0);

        expect(guide.stops.filter((stop) => stop.kind === "core").flatMap((stop) => stop.files.map((entry) => entry.path))).toEqual(["src/core.ts"]);
        expect(guide.stops.find((stop) => stop.kind === "mechanical")?.files.map((entry) => entry.path)).toEqual(["pnpm-lock.yaml"]);
    });

    it("drops files the pull request does not change, and ranges outside the diff", () => {
        const guide = assembleGuide(
            files,
            {
                ...output,
                stops: [
                    {
                        ...output.stops[0],
                        files: [
                            {
                                path: "src/core.ts",
                                ranges: [
                                    { end: 4, side: "new", start: 2 },
                                    { end: 90, side: "new", start: 80 },
                                ],
                            },
                            { path: "/etc/passwd", ranges: [] },
                        ],
                    },
                ],
            },
            0,
        );

        expect(guide.stops[0]?.files).toEqual([{ path: "src/core.ts", ranges: [{ end: 4, side: "new", start: 2 }] }]);
    });

    it("drops a stop that points at nothing the pull request changes", () => {
        const guide = assembleGuide(files, { ...output, stops: [{ ...output.stops[0], files: [{ path: "nope.ts" }] }] }, 0);

        expect(guide.stops.some((stop) => stop.title === "Core")).toBe(false);
    });

    it("keeps comment proposals on diff lines and labels, and nothing else", () => {
        const guide = assembleGuide(
            files,
            {
                ...output,
                proposals: [
                    { body: "Name this better", kind: "comment", line: 3, path: "src/core.ts", side: "new" },
                    { body: "Not in the diff", kind: "comment", line: 400, path: "src/core.ts", side: "new" },
                    { body: "Wrong file", kind: "comment", line: 3, path: "elsewhere.ts", side: "new" },
                    { kind: "label", name: "needs-tests", reason: "No test touches this" },
                    { kind: "approve" },
                    { kind: "merge", method: "squash" },
                    { body: "", kind: "comment", line: 3, path: "src/core.ts", side: "new" },
                ],
            },
            0,
        );

        expect(guide.proposals.map((proposal) => proposal.kind)).toEqual(["comment", "label"]);
        expect(guide.proposals.every((proposal) => proposal.status === "proposed")).toBe(true);
    });

    it("promotes the first stop to core when the model named none", () => {
        const guide = assembleGuide(
            files,
            {
                ...output,
                stops: output.stops.map((stop) => {
                    return { ...stop, role: "dependent" };
                }),
            },
            0,
        );

        expect(guide.stops[0]?.kind).toBe("core");
    });

    it("survives output that is not shaped like a guide", () => {
        const guide = assembleGuide(files, { stops: "everything", summary: 7 } as never, 0);

        expect(guide.stops.map((stop) => stop.kind)).toEqual(["mechanical", "uncovered"]);
        expect(guide.summary).toBe("");
    });

    it("records how many files the host would not list", () => {
        expect(assembleGuide(files, output, 12).leftOut).toBe(12);
    });
});

describe("guideFreshness", () => {
    it("is current on the same head, stale on any other", () => {
        expect(guideFreshness("a".repeat(40), "a".repeat(40))).toBe("current");
        expect(guideFreshness("a".repeat(40), "b".repeat(40))).toBe("stale");
    });
});

describe("extractJsonObject", () => {
    it("reads a bare object, a fenced one and one inside prose", () => {
        expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
        expect(extractJsonObject('Here you go:\n```json\n{"a":{"b":"}"}}\n```\nDone.')).toEqual({ a: { b: "}" } });
        expect(extractJsonObject('I read {the diff} and found {"summary":"x","stops":[]} ok')).toEqual({ stops: [], summary: "x" });
    });

    it("is null when there is no object", () => {
        expect(extractJsonObject("no json here")).toBeNull();
        expect(extractJsonObject('{"unfinished": ')).toBeNull();
        expect(extractJsonObject("")).toBeNull();
    });

    it("gives up on a reply of unmatched braces rather than scanning it for ever", () => {
        expect(extractJsonObject("{".repeat(100_000))).toBeNull();
    });
});

describe("folderMatchesRepo", () => {
    it.each([
        ["hello", "octo/hello", true],
        ["~/Projects/octo/Hello", "octo/hello", true],
        ["C:\\work\\hello\\", "octo/hello", true],
        ["checkout of octo/hello", "octo/hello", true],
        ["hello-world", "octo/hello", false],
        ["other", "octo/hello", false],
        ["", "octo/hello", false],
    ])("%s vs %s is %s", (label, repo, expected) => {
        expect(folderMatchesRepo(label, repo)).toBe(expected);
    });
});
