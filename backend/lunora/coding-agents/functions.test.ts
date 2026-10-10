import { describe, expect, it } from "vitest";

import { appendToLog, canOpenPullRequest } from "./functions";

describe("appendToLog", () => {
    it("appends while under the cap", () => {
        expect(appendToLog("a\n", "b\n")).toBe("a\nb\n");
    });

    it("keeps the tail, cut at a line boundary, with a marker", () => {
        const line = `${"x".repeat(99)}\n`;
        const log = appendToLog("", line.repeat(2000));

        expect(log.length).toBeLessThanOrEqual(96 * 1024);
        expect(log.startsWith("… (earlier output truncated)\n")).toBe(true);
        expect(log.slice("… (earlier output truncated)\n".length).startsWith("x".repeat(99))).toBe(true);
        expect(log.endsWith(line)).toBe(true);
    });
});

describe("canOpenPullRequest", () => {
    const run = { diff: "diff --git", diffTruncated: false, prUrl: undefined, repoUrl: "https://github.com/a/b.git", status: "succeeded" as const };

    it("offers a PR for a finished GitHub run with a complete diff", () => {
        expect(canOpenPullRequest(run)).toBe(true);
    });

    it.each([
        ["still running", { status: "running" as const }],
        ["no change", { diff: "" }],
        ["truncated diff", { diffTruncated: true }],
        ["already opened", { prUrl: "https://github.com/a/b/pull/1" }],
        ["not GitHub", { repoUrl: "https://gitlab.com/a/b.git" }],
    ])("not when %s", (_label, patch) => {
        expect(canOpenPullRequest({ ...run, ...patch })).toBe(false);
    });
});
