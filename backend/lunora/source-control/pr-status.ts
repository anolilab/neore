/**
 * What stands between a linked pull request and its merge, for the chat header's pull request chip: failing checks,
 * a conflict with the base branch, and reviewers whose latest verdict asks for changes. One action reads it with the
 * person's own connection and hands back names and short excerpts only; the page caches the answer per pull request.
 * Host text (check names, review bodies, branch names) is data: the page quotes it, it never becomes an instruction.
 */
import { v } from "lunorash/server";

import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { readFromHost } from "./read-host";
import type { CheckRun, PullRequestReview } from "./types";
import { vFailed } from "./validators";

/** Failing checks named in the answer; the rest are counted. */
export const STATUS_MAX_FAILING_CHECKS = 10;
/** Check pages read: a failure past the first page of 100 is still found, and the read stays bounded. */
export const STATUS_MAX_CHECK_PAGES = 3;
/** Reviewers asking for changes named in the answer; the rest are counted. */
export const STATUS_MAX_CHANGE_REQUESTS = 5;
/** Characters of one review's text handed over. */
export const STATUS_REVIEW_BODY_MAX_CHARS = 500;

export interface ChangeRequest {
    authorLogin: string;
    body: string;
    bodyTruncated: boolean;
}

/**
 * Standings whose verdict holds a pull request back, as on the host, where only reviewers with write access block a merge.
 * Anyone can review a public repository; a stranger's request is not shown as a blocker, nor its text handed to an agent.
 */
const BLOCKING_REVIEWERS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * The reviewers whose latest verdict asks for changes. `reviews` is newest first; a comment-only review keeps the
 * verdict before it, and a later approval or a dismissal ends it. A review from someone without a standing on the
 * repository (when the host names it) does not count.
 */
export const changeRequestsOf = (reviews: ReadonlyArray<PullRequestReview>): ChangeRequest[] => {
    const decided = new Set<string>();
    const requests: ChangeRequest[] = [];

    for (const review of reviews) {
        if (
            decided.has(review.authorLogin) ||
            (review.authorAssociation !== undefined && !BLOCKING_REVIEWERS.has(review.authorAssociation)) ||
            (review.state !== "approved" && review.state !== "changes_requested" && review.state !== "dismissed")
        ) {
            continue;
        }

        decided.add(review.authorLogin);

        if (review.state === "changes_requested") {
            const truncated = review.body.length > STATUS_REVIEW_BODY_MAX_CHARS;

            requests.push({
                authorLogin: review.authorLogin,
                body: truncated ? review.body.slice(0, STATUS_REVIEW_BODY_MAX_CHARS) : review.body,
                bodyTruncated: truncated,
            });
        }
    }

    return requests;
};

/**
 * The names of the checks that block the merge: failed or cancelled, and not optional. The same checks Develop's rollup
 * counts as failing (`checks-logic.ts#rollupOf`), so the chip and Develop agree.
 */
export const failingCheckNamesOf = (checks: ReadonlyArray<CheckRun>): string[] =>
    checks.filter((check) => (check.state === "failure" || check.state === "cancelled") && check.required !== false).map((check) => check.name);

const vOpen = v.object({
    baseBranch: v.string(),
    changeRequests: v.array(v.object({ authorLogin: v.string(), body: v.string(), bodyTruncated: v.boolean() })),
    changeRequestsMore: v.number(),
    conflicting: v.boolean(),
    failingChecks: v.array(v.string()),
    /** Failing checks past the ones named. */
    failingChecksMore: v.number(),
    headBranch: v.string(),
    headSha: v.string(),
    /** The host had not worked out yet whether it merges cleanly: a conflict may show on a later read. */
    mergeUnknown: v.boolean(),
    number: v.number(),
    repository: v.string(),
    state: v.literal("open"),
    status: v.literal("ok"),
    title: v.string(),
    /** Checks the host has but did not list in the one page read: a failure may be among them. */
    unlistedChecks: v.number(),
    url: v.string(),
});

/** The problems on one open pull request; a closed or merged one is reported as such, with no further host call. */
export const getPullRequestStatus = authAction
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.short) })
    .use(rateLimit("sourceControl/read"))
    .output(v.union(vOpen, v.object({ state: v.union(v.literal("closed"), v.literal("merged")), status: v.literal("ok") }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const ref = { number: args.number, repository: args.repository };
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const detail = await DEVELOP_DRIVER.getPullRequest(request, ref);

            if (detail.state !== "open") {
                return { state: detail.state };
            }

            // The merge state comes with the pull request when the host answers it there; only otherwise is it asked for.
            const [checks, mergeState, reviews] = await Promise.all([
                DEVELOP_DRIVER.listChecks(request, ref, detail.headSha, STATUS_MAX_CHECK_PAGES),
                detail.mergeState ?? DEVELOP_DRIVER.getMergeStatus(request, ref).then((merge) => merge.state),
                DEVELOP_DRIVER.listReviews(request, ref),
            ]);
            const failing = failingCheckNamesOf(checks.checks);
            const changeRequests = changeRequestsOf(reviews.items);

            return {
                baseBranch: detail.baseBranch,
                changeRequests: changeRequests.slice(0, STATUS_MAX_CHANGE_REQUESTS),
                changeRequestsMore: Math.max(0, changeRequests.length - STATUS_MAX_CHANGE_REQUESTS),
                conflicting: mergeState === "conflicting",
                failingChecks: failing.slice(0, STATUS_MAX_FAILING_CHECKS),
                failingChecksMore: Math.max(0, failing.length - STATUS_MAX_FAILING_CHECKS),
                headBranch: detail.headBranch,
                headSha: detail.headSha,
                mergeUnknown: mergeState === "unknown",
                number: ref.number,
                repository: ref.repository,
                state: "open" as const,
                title: detail.title,
                unlistedChecks: Math.max(0, checks.total - checks.checks.length),
                url: detail.url,
            };
        });

        ctx.log.event("source_control.get_pull_request_status", { status: outcome.status });

        return outcome;
    });
