/**
 * What an agent's pull request tools do (`chat/tools/pull-request.ts`), run from the agent's action with the person's
 * own connection. Every call first names a pull request LINKED to the thread (`pr-agent.ts`); any other is refused
 * before the host is asked anything. Reads cap what they hand the model; writes go through `writeToHost`, so a refusal
 * carries the host's reason and an answer that never came is `unconfirmed`, never retried here.
 *
 * Whether a write may run at all is the permission layer's call (`chat/lib/tool-permissions.ts`): reply and re-run
 * ask by default, merge asks every time.
 */
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import type { GithubTokenOutcome } from "../connectors/lib/github-token";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { isHostCapabilityAvailable } from "./capabilities";
import { LOG_EXCERPT_MAX_CHARS } from "./check-log";
import { DEVELOP_DRIVER } from "./develop-driver";
import type { HostDriver } from "./driver";
import { requireAddress } from "./pr-threads";
import type { ReadFailure } from "./read-host";
import { readFromHost } from "./read-host";
import type { CheckLog, CheckRun, MergeMethod, PullRequestRef } from "./types";
import { MERGE_METHODS } from "./types";
import type { WriteOutcome } from "./write-host";
import { writeToHost } from "./write-host";

export const AGENT_PR_BODY_MAX_CHARS = 8000;
export const AGENT_COMMENT_MAX_CHARS = 2000;
/** Reviews handed over: the newest ones. */
export const AGENT_MAX_REVIEWS = 30;
/** Failing checks whose logs one read fetches; the rest are named without one. */
export const AGENT_MAX_CHECK_LOGS = 5;
/** Checks one re-run call may name. */
export const AGENT_MAX_RERUNS = 10;
/** Longest reply an agent may post. */
export const AGENT_REPLY_MAX_CHARS = 10_000;

export interface LinkedPullRequest {
    kind: "attached" | "linked" | "opened";
    number: number;
    repository: string;
}

export interface PullRequestAgentDependencies {
    driver: HostDriver;
    linked: () => Promise<LinkedPullRequest[]>;
    token: () => Promise<GithubTokenOutcome>;
}

/** The person's own connection and the thread's links, for one tool call. */
export const agentDependenciesFor = (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string, threadId: string): PullRequestAgentDependencies => {
    return {
        driver: DEVELOP_DRIVER,
        linked: async () => await ctx.runQuery(internal.source_control.pr_agent.linkedPullRequestsOfThread, { threadId, userId }),
        token: async () => await resolveGithubToken(ctx, userId),
    };
};

export interface WantedPullRequest {
    number?: number;
    repository?: string;
}

/** Why no pull request was picked: none is linked, the one named is not, or several are and none was named. */
export type TargetRefusal = { linked: LinkedPullRequest[]; status: "choose" | "none_linked" | "not_linked" };

/** The linked pull request the call names; with none named, the thread's only one. */
export const pickLinkedPullRequest = (linked: LinkedPullRequest[], wanted: WantedPullRequest): TargetRefusal | { ref: PullRequestRef; status: "ok" } => {
    if (linked.length === 0) {
        return { linked, status: "none_linked" };
    }

    if (wanted.repository === undefined && wanted.number === undefined) {
        const [only] = linked;

        return linked.length === 1 && only ? { ref: { number: only.number, repository: only.repository }, status: "ok" } : { linked, status: "choose" };
    }

    let address: PullRequestRef;

    try {
        // The links are stored lower-cased (`requireAddress`), so the name is compared the same way.
        address = requireAddress(wanted.repository ?? "", wanted.number ?? 0);
    } catch {
        return { linked, status: "not_linked" };
    }

    const isLinked = linked.some((link) => link.repository === address.repository && link.number === address.number);

    return isLinked ? { ref: address, status: "ok" } : { linked, status: "not_linked" };
};

const target = async (dependencies: PullRequestAgentDependencies, wanted: WantedPullRequest) => pickLinkedPullRequest(await dependencies.linked(), wanted);

const cap = (text: string, max: number): { text: string; truncated: boolean } =>
    text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

// ─── Read ───────────────────────────────────────────────────────────────────

export const readPullRequestForAgent = async (dependencies: PullRequestAgentDependencies, wanted: WantedPullRequest) => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const { driver } = dependencies;
    const { ref } = picked;

    return await readFromHost(driver, await dependencies.token(), async (request) => {
        const [detail, reviews, threads] = await Promise.all([
            driver.getPullRequest(request, ref),
            driver.listReviews(request, ref),
            driver.listThreads(request, ref, null),
        ]);
        const body = cap(detail.body, AGENT_PR_BODY_MAX_CHARS);

        return {
            moreReviewComments: threads.hasMore,
            pullRequest: {
                authorLogin: detail.authorLogin,
                baseBranch: detail.baseBranch,
                body: body.text,
                bodyTruncated: body.truncated || detail.bodyTruncated,
                draft: detail.draft,
                headBranch: detail.headBranch,
                headSha: detail.headSha,
                number: ref.number,
                repository: ref.repository,
                state: detail.state,
                title: detail.title,
                url: detail.url,
            },
            reviewComments: threads.items.map((thread) => {
                return {
                    comments: thread.comments.map((comment) => {
                        return { authorLogin: comment.authorLogin, body: cap(comment.body, AGENT_COMMENT_MAX_CHARS).text, id: comment.id };
                    }),
                    isOutdated: thread.isOutdated,
                    isResolved: thread.isResolved,
                    line: thread.line,
                    path: thread.path,
                };
            }),
            reviews: reviews.slice(-AGENT_MAX_REVIEWS).map((review) => {
                return { authorLogin: review.authorLogin, body: cap(review.body, AGENT_COMMENT_MAX_CHARS).text, state: review.state };
            }),
        };
    });
};

const FAILING: ReadonlySet<CheckRun["state"]> = new Set(["failure"]);
const RERUNNABLE: ReadonlySet<CheckRun["state"]> = new Set(["cancelled", "failure"]);

export interface FailingCheck {
    id: string | null;
    log: CheckLog | null;
    name: string;
    required: boolean | null;
    url: string | null;
}

/** The failing checks on the pull request's head, each with a capped excerpt of its log (the first few only). */
export const readFailingChecksForAgent = async (dependencies: PullRequestAgentDependencies, wanted: WantedPullRequest) => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const { driver } = dependencies;
    const { ref } = picked;

    return await readFromHost(driver, await dependencies.token(), async (request) => {
        const detail = await driver.getPullRequest(request, ref);
        const summary = await driver.listChecks(request, ref, detail.headSha);
        const failing = summary.checks.filter((check) => FAILING.has(check.state));
        const checks: FailingCheck[] = [];

        // One log at a time: a log read is the heavy call, and the first few failures are what the agent needs.
        for (const [index, check] of failing.entries()) {
            const log =
                check.id !== null && index < AGENT_MAX_CHECK_LOGS
                    ? await driver.readCheckLog(request, ref, check.id, LOG_EXCERPT_MAX_CHARS).catch(() => null)
                    : null;

            checks.push({ id: check.id, log, name: check.name, required: check.required, url: check.url });
        }

        return {
            checks,
            headSha: detail.headSha,
            passing: summary.checks.filter((check) => check.state === "success").length,
            pending: summary.checks.filter((check) => check.state === "pending").length,
            total: summary.total,
        };
    });
};

// ─── Write ──────────────────────────────────────────────────────────────────

export type AgentWriteOutcome<T extends object> = TargetRefusal | WriteOutcome<T> | { status: "empty_reply" | "unsupported" } | { status: ReadFailure };

/** Replies under the review comment `commentId` names, on that pull request: the host's address scopes it there. */
export const replyForAgent = async (
    dependencies: PullRequestAgentDependencies,
    wanted: WantedPullRequest,
    commentId: string,
    body: string,
): Promise<AgentWriteOutcome<{ commentId: string }>> => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    if (body.trim() === "") {
        return { status: "empty_reply" };
    }

    const { driver } = dependencies;

    return await writeToHost(driver, await dependencies.token(), async (request) => {
        const reply = await driver.replyToThread(request, picked.ref, commentId, body.slice(0, AGENT_REPLY_MAX_CHARS));

        return { commentId: reply.id };
    });
};

export interface RerunResult {
    id: string;
    name: string;
    reason?: string | null;
    status: WriteOutcome<object>["status"];
}

/**
 * Re-runs the failed checks on the pull request's head: the ones named, or every one that can be re-run. A check id
 * that is not a failed check on that head is skipped, so a call cannot reach a check of another pull request.
 */
export const rerunFailedForAgent = async (
    dependencies: PullRequestAgentDependencies,
    wanted: WantedPullRequest,
    checkIds: string[] | undefined,
): Promise<AgentWriteOutcome<{ rerun: RerunResult[]; skipped: string[] }>> => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const { driver } = dependencies;

    if (!isHostCapabilityAvailable(driver.view.capabilities, "checks.rerun")) {
        return { status: "unsupported" };
    }

    const token = await dependencies.token();
    const listed = await readFromHost(driver, token, async (request) => {
        const detail = await driver.getPullRequest(request, picked.ref);

        return await driver.listChecks(request, picked.ref, detail.headSha);
    });

    if (listed.status !== "ok") {
        return listed;
    }

    const failed = listed.checks.filter((check): check is CheckRun & { id: string } => check.id !== null && RERUNNABLE.has(check.state));
    const chosen = checkIds === undefined ? failed : failed.filter((check) => checkIds.includes(check.id));
    const skipped = checkIds === undefined ? [] : checkIds.filter((id) => chosen.every((check) => check.id !== id));
    const rerun: RerunResult[] = [];

    for (const check of chosen.slice(0, AGENT_MAX_RERUNS)) {
        const outcome = await writeToHost(driver, token, async (request) => {
            await driver.rerunCheck(request, picked.ref, check.id);

            return {};
        });

        rerun.push({ id: check.id, name: check.name, status: outcome.status, ...(outcome.status === "rejected" && { reason: outcome.reason }) });
    }

    return { rerun, skipped, status: "ok" };
};

/** The method a merge uses: the one asked for when the repository allows it, else squash, else the first it allows. */
export const pickMergeMethod = (allowed: MergeMethod[], asked: MergeMethod | undefined): MergeMethod | undefined => {
    if (asked !== undefined) {
        return allowed.includes(asked) ? asked : undefined;
    }

    return allowed.includes("squash") ? "squash" : MERGE_METHODS.find((method) => allowed.includes(method));
};

/**
 * Merges the pull request at the head the approved call names. The host refuses a head that moved; a pull request that
 * is not open, or whose head is not the one named, is refused here first so the person is told plainly.
 */
export const mergeForAgent = async (
    dependencies: PullRequestAgentDependencies,
    wanted: WantedPullRequest,
    headSha: string,
    method: MergeMethod | undefined,
): Promise<AgentWriteOutcome<{ sha: string | null }> | { status: "head_moved" | "method_not_allowed" | "not_open" }> => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const { driver } = dependencies;

    if (!isHostCapabilityAvailable(driver.view.capabilities, "merge.now")) {
        return { status: "unsupported" };
    }

    const token = await dependencies.token();
    const state = await readFromHost(driver, token, async (request) => {
        const [detail, merge] = await Promise.all([driver.getPullRequest(request, picked.ref), driver.getMergeStatus(request, picked.ref)]);

        return { headSha: detail.headSha, methods: merge.methods, state: detail.state };
    });

    if (state.status !== "ok") {
        return state;
    }

    if (state.state !== "open") {
        return { status: "not_open" };
    }

    if (state.headSha !== headSha) {
        return { status: "head_moved" };
    }

    const chosen = pickMergeMethod(state.methods, method);

    if (chosen === undefined) {
        return { status: "method_not_allowed" };
    }

    return await writeToHost(driver, token, async (request) => await driver.mergePullRequest(request, picked.ref, { headSha, method: chosen }));
};
