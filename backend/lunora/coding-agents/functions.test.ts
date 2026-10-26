import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { appendToLog, beginPullRequest, canOpenPullRequest, completePullRequest, expirePullRequest, isPullRequestStale } from "./functions";
import { PR_BUDGET_MS } from "./runner";

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

const REAP_AFTER_MS = PR_BUDGET_MS + 3 * 60 * 1000;
const USER = "user-a";

describe("pull request reaper", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const insertRun = async (overrides: Record<string, unknown> = {}): Promise<string> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("codingAgentRuns", {
                    agent: "claude_code",
                    baseBranch: "main",
                    createdAt: 1,
                    diff: "diff --git a/x b/x",
                    log: "",
                    openPr: false,
                    prompt: "Fix it",
                    repoUrl: "https://github.com/a/b.git",
                    status: "succeeded",
                    updatedAt: 1,
                    userId: USER,
                    ...overrides,
                }),
        );

    const getRun = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

    const mutate = async (reference: unknown, args: Record<string, unknown>): Promise<any> =>
        await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

    it("fails a stuck pending PR, names its branch and frees the run for a retry", async () => {
        const runId = await insertRun({ prFollowUp: true, prSandboxId: "sbx-1", prStartedAt: 100, prStatus: "pending" });

        expect(await mutate(expirePullRequest, { runId, startedAt: 100 })).toStrictEqual({ followUp: true, sandboxId: "sbx-1" });

        const run = await getRun(runId);

        expect(run.prStatus).toBe("failed");
        expect("prStartedAt" in run).toBe(false);
        expect("prSandboxId" in run).toBe(false);
        expect(run.log).toContain("Could not open the pull request: timed out.");
        expect(run.log).toContain("neore/agent-");
        expect(canOpenPullRequest(run)).toBe(true);
    });

    it("does nothing for a reaper scheduled for an older attempt", async () => {
        const runId = await insertRun({ prStartedAt: 200, prStatus: "pending" });

        expect(await mutate(expirePullRequest, { runId, startedAt: 100 })).toBeNull();
        expect(await getRun(runId)).toMatchObject({ prStartedAt: 200, prStatus: "pending" });
    });

    it("does not touch a finished PR", async () => {
        const opened = await insertRun({ prUrl: "https://github.com/a/b/pull/1" });
        const failed = await insertRun({ prStatus: "failed", log: "earlier\n" });

        expect(await mutate(expirePullRequest, { runId: opened, startedAt: 100 })).toBeNull();
        expect(await mutate(expirePullRequest, { runId: failed, startedAt: 100 })).toBeNull();
        expect(await getRun(opened)).toMatchObject({ prUrl: "https://github.com/a/b/pull/1" });
        expect(await getRun(failed)).toMatchObject({ log: "earlier\n", prStatus: "failed" });
    });

    it("does not touch a PR that completed after the reaper was scheduled", async () => {
        const runId = await insertRun({ prStartedAt: 100, prStatus: "pending" });

        await mutate(completePullRequest, { log: "Opened\n", prUrl: "https://github.com/a/b/pull/2", runId });

        expect(await mutate(expirePullRequest, { runId, startedAt: 100 })).toBeNull();
        expect(await getRun(runId)).toMatchObject({ prUrl: "https://github.com/a/b/pull/2" });
    });

    it("schedules the reaper when it claims the PR", async () => {
        const runId = await insertRun();

        expect(await mutate(beginPullRequest, { followUp: false, runId, userId: USER })).toMatchObject({ baseBranch: "main" });
        expect(await getRun(runId)).toMatchObject({ prStatus: "pending" });
        expect(harness.scheduler.list()).toHaveLength(1);
    });

    it("refuses a fresh pending claim but takes over a stale one", async () => {
        const fresh = await insertRun({ prStartedAt: Date.now(), prStatus: "pending" });
        const stale = await insertRun({ prSandboxId: "sbx-old", prStartedAt: Date.now() - REAP_AFTER_MS - 1000, prStatus: "pending" });

        expect(await mutate(beginPullRequest, { followUp: false, runId: fresh, userId: USER })).toStrictEqual({
            error: "A pull request for this run is already being opened.",
        });
        expect(await mutate(beginPullRequest, { followUp: false, runId: stale, userId: USER })).toMatchObject({ baseBranch: "main" });

        const run = await getRun(stale);

        expect(run.prStatus).toBe("pending");
        expect("prSandboxId" in run).toBe(false);
        expect(run.prStartedAt).toBeGreaterThan(Date.now() - 60_000);
    });
});

describe("isPullRequestStale", () => {
    it("is stale only when pending past the budget plus grace", () => {
        expect(isPullRequestStale({ prStartedAt: 0, prStatus: "pending", updatedAt: 0 }, REAP_AFTER_MS)).toBe(false);
        expect(isPullRequestStale({ prStartedAt: 0, prStatus: "pending", updatedAt: 0 }, REAP_AFTER_MS + 1)).toBe(true);
        expect(isPullRequestStale({ prStartedAt: 0, prStatus: "failed", updatedAt: 0 }, REAP_AFTER_MS + 1)).toBe(false);
        expect(isPullRequestStale({ prStatus: "pending", updatedAt: 0 }, REAP_AFTER_MS + 1)).toBe(true);
    });
});
