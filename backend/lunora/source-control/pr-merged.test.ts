/**
 * The merged-pull-request helper, run against a fake action context: the repository is looked up in the form links are stored
 * under, an invalid address is logged rather than thrown, and one chat that fails its archive does not stop the others.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { enqueueJob } from "../lib/job-queue";
import { continueMergedRecording, recordMergedPullRequest } from "./pr-merged";

vi.mock("../lib/job-queue", () => {
    return { enqueueJob: vi.fn(async () => undefined) };
});

type Call = { args: Record<string, unknown>; ref: unknown };

const LINK_A = "link-a";
const LINK_B = "link-b";
const THREAD_A = "thread-a";
const THREAD_B = "thread-b";

/** A context whose mutations answer the way the real ones do for two owed links; `failArchiveOf` makes one archive throw. */
const fakeContext = (failArchiveOf?: string) => {
    const calls: Call[] = [];
    const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        calls.push({ args, ref });

        if (ref === internal.source_control.pr_threads.recordPullRequestMergedPage) {
            return {
                continueCursor: null,
                isDone: true,
                owed: [
                    { lastAttemptAt: 0, linkId: LINK_A, threadId: THREAD_A },
                    { lastAttemptAt: 0, linkId: LINK_B, threadId: THREAD_B },
                ],
            };
        }

        if (ref === internal.agent.auto_archive.archiveMergedThread && args.threadId === failArchiveOf) {
            throw new Error("archive failed");
        }

        return null;
    });

    return { calls, ctx: { runMutation } as never };
};

const callsTo = (calls: Call[], ref: unknown) => calls.filter((call) => call.ref === ref);

afterEach(() => {
    vi.restoreAllMocks();
});

describe("recordMergedPullRequest", () => {
    it("looks the pull request up under its canonical lowercase repository, whatever the casing it was given", async () => {
        const { calls, ctx } = fakeContext();

        await recordMergedPullRequest(ctx, "user-a", { number: 7, repository: "Octo/Hello" });

        const [record] = callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage);

        expect(record?.args).toMatchObject({ number: 7, repository: "octo/hello", userId: "user-a" });

        for (const archive of callsTo(calls, internal.agent.auto_archive.archiveMergedThread)) {
            expect(archive.args).toMatchObject({ repository: "octo/hello" });
        }
    });

    it("passes the host's merge time through when it was given, and leaves it out when the merge is now", async () => {
        const given = fakeContext();

        await recordMergedPullRequest(given.ctx, "user-a", { number: 7, repository: "octo/hello" }, 1000);

        expect(callsTo(given.calls, internal.source_control.pr_threads.recordPullRequestMergedPage)[0]?.args).toMatchObject({ mergedAt: 1000 });

        const now = fakeContext();

        await recordMergedPullRequest(now.ctx, "user-a", { number: 7, repository: "octo/hello" });

        expect(callsTo(now.calls, internal.source_control.pr_threads.recordPullRequestMergedPage)[0]?.args).not.toHaveProperty("mergedAt");
    });

    it("logs an invalid address and does nothing, without throwing", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { calls, ctx } = fakeContext();

        await expect(recordMergedPullRequest(ctx, "user-a", { number: 7, repository: "not-a-repository" })).resolves.toBeUndefined();

        expect(calls).toHaveLength(0);
        expect(error).toHaveBeenCalled();
    });

    it("walks every page of a pull request's links, and caps the archive attempts across the whole read", async () => {
        const calls: Call[] = [];
        const owedOf = (prefix: string, count: number, lastAttemptAt = 0) =>
            Array.from({ length: count }, (_, index) => {
                return { lastAttemptAt, linkId: `${prefix}-${String(index)}`, threadId: `${prefix}-thread-${String(index)}` };
            });
        const pages = [
            { continueCursor: "page-2", isDone: false, owed: owedOf("a", 20) },
            { continueCursor: null, isDone: true, owed: owedOf("b", 20) },
        ];
        const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });

            if (ref === internal.source_control.pr_threads.recordPullRequestMergedPage) {
                return pages[args.cursor === "page-2" ? 1 : 0];
            }

            return null;
        });

        await recordMergedPullRequest({ runMutation } as never, "user-a", { number: 7, repository: "octo/hello" });

        // Both pages are recorded, the second with the first page's cursor; 40 owed links but only 25 archive attempts in this read.
        expect(callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage).map((call) => call.args.cursor)).toStrictEqual([null, "page-2"]);
        expect(callsTo(calls, internal.agent.auto_archive.archiveMergedThread)).toHaveLength(25);
    });

    it("spends the attempts on the least recently attempted owed links across every page, so busy first-page chats cannot starve a later page", async () => {
        const calls: Call[] = [];
        // Page one: 25 chats that were just found busy (attempted recently). Page two: one chat never attempted.
        const busy = Array.from({ length: 25 }, (_, index) => {
            return { lastAttemptAt: 1_000_000, linkId: `busy-${String(index)}`, threadId: `busy-thread-${String(index)}` };
        });
        const pages = [
            { continueCursor: "page-2", isDone: false, owed: busy },
            { continueCursor: null, isDone: true, owed: [{ lastAttemptAt: 0, linkId: "fresh", threadId: "fresh-thread" }] },
        ];
        const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });

            if (ref === internal.source_control.pr_threads.recordPullRequestMergedPage) {
                return pages[args.cursor === "page-2" ? 1 : 0];
            }

            return null;
        });

        await recordMergedPullRequest({ runMutation } as never, "user-a", { number: 7, repository: "octo/hello" });

        const attempted = callsTo(calls, internal.agent.auto_archive.archiveMergedThread).map((call) => call.args.linkId);

        // Every page is recorded before any attempt, and the never-attempted link on page two gets one within the cap.
        expect(callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage)).toHaveLength(2);
        expect(attempted).toContain("fresh");
        expect(attempted).toHaveLength(25);
    });

    it("restarts the walk from the first page when a cursor is no longer read, and attempts each owed link once", async () => {
        const calls: Call[] = [];
        let invalidated = false;
        const owedOf = (prefix: string, count: number) =>
            Array.from({ length: count }, (_, index) => {
                return { lastAttemptAt: 0, linkId: `${prefix}-${String(index)}`, threadId: `${prefix}-thread-${String(index)}` };
            });
        const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });

            if (ref === internal.source_control.pr_threads.recordPullRequestMergedPage) {
                // The second page's cursor is rejected once, as after a write between pages.
                if (args.cursor === "page-2" && !invalidated) {
                    invalidated = true;
                    throw Object.assign(new Error("cursor"), { code: "INVALID_CURSOR" });
                }

                return args.cursor === "page-2"
                    ? { continueCursor: null, isDone: true, owed: owedOf("b", 20) }
                    : { continueCursor: "page-2", isDone: false, owed: owedOf("a", 20) };
            }

            return null;
        });

        await recordMergedPullRequest({ runMutation } as never, "user-a", { number: 7, repository: "octo/hello" });

        // The walk restarted from the first page and read the second page again.
        expect(callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage).map((call) => call.args.cursor)).toStrictEqual([
            null,
            "page-2",
            null,
            "page-2",
        ]);

        // The first page's owed links were seen twice: each is attempted once, and the read still caps at 25 attempts.
        const attempted = callsTo(calls, internal.agent.auto_archive.archiveMergedThread).map((call) => call.args.linkId);

        expect(attempted).toHaveLength(25);
        expect(new Set(attempted).size).toBe(25);
    });

    it("records at most ten pages in one action, queues the rest from the cursor it stopped at, and the queued job records the rest", async () => {
        const calls: Call[] = [];
        // Twelve pages, cursors `c-1` .. `c-11`. A page's cursor names the page after it; the last page is `c-11`.
        const twelvePages = (args: Record<string, unknown>) => {
            const index = args.cursor === null ? 0 : Number(String(args.cursor).slice(2));

            return { continueCursor: `c-${String(index + 1)}`, isDone: index === 11, owed: [] };
        };
        const runMutation = vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });

            return ref === internal.source_control.pr_threads.recordPullRequestMergedPage ? twelvePages(args) : null;
        });

        // The first action queues the rest through the jobs queue; capture what it sends.
        const queued = vi.mocked(enqueueJob);

        queued.mockClear();
        await recordMergedPullRequest({ runMutation, scheduler: {} } as never, "user-a", { number: 7, repository: "octo/hello" });

        const pagesFirst = callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage);

        expect(pagesFirst).toHaveLength(10);
        expect(queued).toHaveBeenCalledTimes(1);

        const [jobRef, jobArgs, jobOptions] = queued.mock.calls[0] ?? [];

        expect(jobRef).toBe(internal.source_control.pr_merged.continueMergedRecordingJob);
        expect(jobArgs).toMatchObject({ cursor: "c-10", number: 7, repository: "octo/hello", userId: "user-a" });
        expect(jobOptions).toStrictEqual({ shardKey: "user-a" });

        // The queued job runs the rest of the walk: it records the last two pages and queues nothing more.
        calls.length = 0;
        queued.mockClear();
        await continueMergedRecording({ runMutation, scheduler: {} } as never, { ...(jobArgs as Record<string, unknown>), cursor: "c-10" } as never);

        const pagesRest = callsTo(calls, internal.source_control.pr_threads.recordPullRequestMergedPage).map((call) => call.args.cursor);

        expect(pagesRest).toStrictEqual(["c-10", "c-11"]);
        expect(queued).not.toHaveBeenCalled();
    });

    it("keeps going when one archive fails, and each owed link is archived by its own attempt", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { calls, ctx } = fakeContext(THREAD_A);

        await recordMergedPullRequest(ctx, "user-a", { number: 7, repository: "octo/hello" });

        // The first chat's archive threw (its link stays owed for the next read); the second chat's attempt still ran.
        const archived = callsTo(calls, internal.agent.auto_archive.archiveMergedThread).map((call) => call.args.linkId);

        expect(archived).toStrictEqual([LINK_A, LINK_B]);
    });
});
