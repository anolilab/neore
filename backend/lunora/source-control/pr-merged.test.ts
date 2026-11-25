/**
 * The merged-pull-request helper, run against a fake action context: the repository is looked up in the form links are stored
 * under, an invalid address is logged rather than thrown, and one chat that fails its archive does not stop the others.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { recordMergedPullRequest } from "./pr-merged";

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

        if (ref === internal.source_control.pr_threads.recordPullRequestMerged) {
            return [
                { linkId: LINK_A, threadId: THREAD_A },
                { linkId: LINK_B, threadId: THREAD_B },
            ];
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

        const [record] = callsTo(calls, internal.source_control.pr_threads.recordPullRequestMerged);

        expect(record?.args).toMatchObject({ number: 7, repository: "octo/hello", userId: "user-a" });

        for (const archive of callsTo(calls, internal.agent.auto_archive.archiveMergedThread)) {
            expect(archive.args).toMatchObject({ repository: "octo/hello" });
        }
    });

    it("passes the host's merge time through when it was given, and leaves it out when the merge is now", async () => {
        const given = fakeContext();

        await recordMergedPullRequest(given.ctx, "user-a", { number: 7, repository: "octo/hello" }, 1000);

        expect(callsTo(given.calls, internal.source_control.pr_threads.recordPullRequestMerged)[0]?.args).toMatchObject({ mergedAt: 1000 });

        const now = fakeContext();

        await recordMergedPullRequest(now.ctx, "user-a", { number: 7, repository: "octo/hello" });

        expect(callsTo(now.calls, internal.source_control.pr_threads.recordPullRequestMerged)[0]?.args).not.toHaveProperty("mergedAt");
    });

    it("logs an invalid address and does nothing, without throwing", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { calls, ctx } = fakeContext();

        await expect(recordMergedPullRequest(ctx, "user-a", { number: 7, repository: "not-a-repository" })).resolves.toBeUndefined();

        expect(calls).toHaveLength(0);
        expect(error).toHaveBeenCalled();
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
