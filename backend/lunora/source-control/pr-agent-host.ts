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
import type { CheckLog, CheckRun, CursorPage, MergeMethod, PullRequestRef, ReviewThread } from "./types";
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
/** Comments of one review thread handed over: its first, then its latest. */
export const AGENT_COMMENTS_PER_THREAD = 10;
/** Characters of review comments one read hands over in all; the threads past it are counted, not sent. */
export const AGENT_REVIEW_COMMENTS_BUDGET_CHARS = 40_000;
/** Review thread pages one read goes through before it hands back a cursor. */
export const AGENT_MAX_THREAD_PAGES = 4;
/** Check pages one read goes through: past them, the host's own total says how many were not listed. */
export const AGENT_MAX_CHECK_PAGES = 10;
/** Failing checks one read names; past them, the marker counts the rest. */
export const AGENT_MAX_FAILING_CHECKS = 30;
/** Time one failing-checks read spends on logs in all: shared by the logs it reads, one after another. */
export const AGENT_LOG_READ_BUDGET_MS = 60_000;
/** Time left below which no further log is started: it could not be read in time anyway. */
export const AGENT_MIN_LOG_READ_MS = 2000;
/** Longest reply an agent may post. */
export const AGENT_REPLY_MAX_CHARS = 10_000;

export interface LinkedPullRequest {
    kind: "attached" | "linked" | "opened";
    number: number;
    repository: string;
}

export interface PullRequestAgentDependencies {
    /** Whether the thread is one the tools may run in at all (`pullRequestToolsAllowed`): asked before anything else. */
    allowed: () => Promise<boolean>;
    driver: HostDriver;
    /** Whether this one pull request is linked to the thread: a keyed read, so a thread with many links is not cut short. */
    isLinked: (ref: PullRequestRef) => Promise<boolean>;
    /** The thread's links, as far as the read goes: `complete` is `false` past its bound. */
    linked: () => Promise<{ complete: boolean; links: LinkedPullRequest[] }>;
    token: () => Promise<GithubTokenOutcome>;
}

/** The person's own connection and the thread's links, for one tool call. */
export const agentDependenciesFor = (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string, threadId: string): PullRequestAgentDependencies => {
    return {
        allowed: async () => await ctx.runQuery(internal.source_control.pr_agent.pullRequestToolsAllowed, { threadId, userId }),
        driver: DEVELOP_DRIVER,
        isLinked: async (ref) =>
            await ctx.runQuery(internal.source_control.pr_agent.isPullRequestLinkedToThread, {
                number: ref.number,
                repository: ref.repository,
                threadId,
                userId,
            }),
        linked: async () => await ctx.runQuery(internal.source_control.pr_agent.linkedPullRequestsOfThread, { threadId, userId }),
        token: async () => await resolveGithubToken(ctx, userId),
    };
};

export interface WantedPullRequest {
    number?: number;
    repository?: string;
}

/**
 * Why no pull request was picked: the thread is not one the tools may run in (`not_allowed`, nothing else is read),
 * none is linked, the one named is not, or several are and none was named.
 */
export type TargetRefusal = { linked: LinkedPullRequest[]; status: "choose" | "none_linked" | "not_linked" } | { status: "not_allowed" };

/**
 * The linked pull request the call names. With none named, the thread's only one; with only a number or only a
 * repository, the one link that matches it. With both named, `target` asks for that one link by key.
 */
export const pickLinkedPullRequest = (
    linked: LinkedPullRequest[],
    wanted: WantedPullRequest,
    complete = true,
): TargetRefusal | { ref: PullRequestRef; status: "ok" } => {
    if (linked.length === 0 && complete) {
        return { linked, status: "none_linked" };
    }

    // The links are stored lower-cased (`requireAddress`), so a repository is compared the same way.
    const repo = wanted.repository?.toLowerCase();
    const matches = linked.filter((link) => (repo === undefined || link.repository === repo) && (wanted.number === undefined || link.number === wanted.number));
    const [only] = matches;

    // Past the read's bound, a lone match may not be the only one and no match is not proof: ask for both fields,
    // which `target` checks by key.
    if (!complete) {
        return { linked, status: "choose" };
    }

    if (matches.length === 1 && only) {
        return { ref: { number: only.number, repository: only.repository }, status: "ok" };
    }

    return { linked, status: matches.length === 0 ? "not_linked" : "choose" };
};

/** The pull request a call names, refused unless it is linked to the thread. */
const target = async (
    dependencies: PullRequestAgentDependencies,
    wanted: WantedPullRequest,
): Promise<TargetRefusal | { ref: PullRequestRef; status: "ok" }> => {
    // First, before any link or host read: a run nobody but the owner steers, in a thread nobody but the owner reads.
    if (!(await dependencies.allowed())) {
        return { status: "not_allowed" };
    }

    if (wanted.repository === undefined || wanted.number === undefined) {
        const { complete, links } = await dependencies.linked();

        return pickLinkedPullRequest(links, wanted, complete);
    }

    let address: PullRequestRef;

    try {
        address = requireAddress(wanted.repository, wanted.number);
    } catch {
        return { linked: [], status: "not_linked" };
    }

    if (await dependencies.isLinked(address)) {
        return { ref: address, status: "ok" };
    }

    const { links } = await dependencies.linked();

    return { linked: links, status: "not_linked" };
};

const cap = (text: string, max: number): { text: string; truncated: boolean } =>
    text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

/** The one marker every capped part of an answer carries: `truncated, N more`, or nothing when nothing was left out. */
export const truncatedMarker = (more: number): { truncated?: string } => (more > 0 ? { truncated: `truncated, ${String(more)} more` } : {});

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * The pull request, its newest reviews, and its review threads as far as the budget goes. `reviewCursor` is the
 * `reviewComments.nextCursor` an earlier read returned: the threads after those it showed.
 */
export const readPullRequestForAgent = async (dependencies: PullRequestAgentDependencies, wanted: WantedPullRequest, reviewCursor?: string) => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const from = parseThreadCursor(reviewCursor);

    if (from === null) {
        return { status: "bad_cursor" as const };
    }

    const { driver } = dependencies;
    const { ref } = picked;

    const outcome = await readFromHost(driver, await dependencies.token(), async (request) => {
        const [detail, reviews, threads] = await Promise.all([
            driver.getPullRequest(request, ref),
            driver.listReviews(request, ref),
            readThreadsWithin(async (after) => await driver.listThreads(request, ref, after), from),
        ]);
        const body = cap(detail.body, AGENT_PR_BODY_MAX_CHARS);
        const shownReviews = reviews.items.slice(0, AGENT_MAX_REVIEWS);

        return {
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
            reviewComments: threads,
            // Newest first: the latest verdict is what to act on.
            reviews: {
                items: shownReviews.map((review) => {
                    const shown = cap(review.body, AGENT_COMMENT_MAX_CHARS);

                    return { authorLogin: review.authorLogin, body: shown.text, ...(shown.truncated && { bodyTruncated: true }), state: review.state };
                }),
                ...truncatedMarker(reviews.total - shownReviews.length),
            },
        };
    });

    return outcome;
};

/** The marker for comments left out of a thread with pages unread and no total: never a count of zero, since some are missing. */
const unreadCount = (counted: number): string => (counted > 0 ? `truncated, at least ${String(counted)} more` : "truncated, more were not read");

/** One review thread as an agent reads it: its first comment and its latest ones, each cut short, the rest counted. */
const threadForAgent = (thread: ReviewThread) => {
    const [first, ...rest] = thread.comments;
    const kept = first === undefined ? [] : [first, ...rest.slice(-(AGENT_COMMENTS_PER_THREAD - 1))];

    return {
        comments: {
            items: kept.map((comment) => {
                const shown = cap(comment.body, AGENT_COMMENT_MAX_CHARS);

                return { authorLogin: comment.authorLogin, body: shown.text, ...(shown.truncated && { bodyTruncated: true }), id: comment.id };
            }),
            // Counted against the thread's own total: comments past the pages read are left out too. Without a total and
            // with pages unread, the count is of the comments read only: said so ("at least").
            ...(thread.commentCount === undefined && thread.commentsComplete === false
                ? { truncated: unreadCount(thread.comments.length - kept.length) }
                : truncatedMarker((thread.commentCount ?? thread.comments.length) - kept.length)),
            // Longer than the pages read: the comments shown are the latest READ, and the thread's very latest are not among them.
            ...(((thread.commentCount ?? 0) > thread.comments.length || thread.commentsComplete === false) && { latestUnread: true }),
        },
        isOutdated: thread.isOutdated,
        isResolved: thread.isResolved,
        line: thread.line,
        path: thread.path,
    };
};

type AgentThread = ReturnType<typeof threadForAgent>;

/**
 * Where a read of review threads goes on from: the host's page cursor (empty for the first page) and how many threads
 * of that page were already handed over, as `<cursor>#<skip>`. Its own form, so a read can stop inside a page and the
 * next one goes on from the next thread: none comes twice, none is lost.
 */
const THREAD_CURSOR = /^(?<page>[\w=+/-]{0,500})#(?<skip>\d{1,3})$/u;

/** The most threads any host's page of review threads holds (the host API's own page ceiling). */
const MAX_THREADS_PER_HOST_PAGE = 100;

export const parseThreadCursor = (cursor: string | null | undefined): { page: string | null; skip: number } | null => {
    if (cursor === null || cursor === undefined) {
        return { page: null, skip: 0 };
    }

    const match = THREAD_CURSOR.exec(cursor);
    const skip = Number(match?.groups?.skip);

    // No host page holds more than this many threads: a skip past it is not one a read gave.
    if (!match?.groups || skip > MAX_THREADS_PER_HOST_PAGE) {
        return null;
    }

    return { page: match.groups.page === "" ? null : (match.groups.page ?? null), skip };
};

const threadCursor = (page: string | null, skip: number): string => `${page ?? ""}#${String(skip)}`;

/**
 * The review threads one read hands over: page after page, up to {@link AGENT_MAX_THREAD_PAGES}, while the characters
 * last ({@link AGENT_REVIEW_COMMENTS_BUDGET_CHARS}). `nextCursor` goes on from the first thread not shown, and the
 * marker says how many are left: a count from the start, where the host gives its total.
 */
export const readThreadsWithin = async (readPage: (after: string | null) => Promise<CursorPage<ReviewThread>>, from: { page: string | null; skip: number }) => {
    const items: AgentThread[] = [];
    let spent = 0;
    let { page, skip } = from;
    let total: number | undefined;
    let nextCursor: string | null = null;

    for (let read = 0; read < AGENT_MAX_THREAD_PAGES; read += 1) {
        const answer = await readPage(page);

        // A page can shrink between two reads (a thread deleted on the host): a skip past its end means the page is done.
        const threads = answer.items.slice(Math.min(skip, answer.items.length));
        let shownOfPage = Math.min(skip, answer.items.length);

        total ??= answer.total;

        for (const thread of threads) {
            const shown = threadForAgent(thread);
            const size = shown.comments.items.reduce((sum, comment) => sum + comment.body.length, 0);

            if (spent + size > AGENT_REVIEW_COMMENTS_BUDGET_CHARS && items.length > 0) {
                break;
            }

            spent += size;
            items.push(shown);
            shownOfPage += 1;
        }

        if (shownOfPage < answer.items.length) {
            nextCursor = threadCursor(page, shownOfPage);
            break;
        }

        if (!answer.hasMore) {
            nextCursor = null;
            break;
        }

        page = answer.endCursor;
        skip = 0;
        nextCursor = threadCursor(page, 0);
    }

    const fromStart = from.page === null && from.skip === 0;
    let marker: { truncated?: string } = {};

    if (nextCursor !== null) {
        marker = fromStart && total !== undefined ? truncatedMarker(total - items.length) : { truncated: "truncated, more after nextCursor" };
    }

    return { items, nextCursor, ...marker };
};

const FAILING: ReadonlySet<CheckRun["state"]> = new Set(["failure"]);
/** States a check named by id may be re-run from; a call that names none re-runs the failed ones only. */
const RERUNNABLE: ReadonlySet<CheckRun["state"]> = new Set(["cancelled", "failure"]);

export interface FailingCheck {
    id: string | null;
    log: CheckLog | null;
    /**
     * Why there is no log: `not_read` past the first few failing checks, or for a check the host cannot re-read (a
     * commit status); `unavailable` when reading it failed; `none` when the host has neither a log nor any output for it.
     */
    logStatus: "none" | "not_read" | "ok" | "unavailable";
    name: string;
    required: boolean | null;
    url: string | null;
}

/** Why a check has, or has not, a log in the answer (see {@link FailingCheck.logStatus}). */
const logStatusOf = (read: boolean, log: CheckLog | null): FailingCheck["logStatus"] => {
    if (!read) {
        return "not_read";
    }

    if (log === null || (log.source === "none" && log.refused === true)) {
        return "unavailable";
    }

    return log.source === "none" ? "none" : "ok";
};

/**
 * The failing checks on the pull request's head, each with a capped excerpt of its log: the first few only, and only
 * while the read's one time budget lasts ({@link AGENT_LOG_READ_BUDGET_MS}), so a call never waits on slow logs for long.
 */
export const readFailingChecksForAgent = async (dependencies: PullRequestAgentDependencies, wanted: WantedPullRequest) => {
    const picked = await target(dependencies, wanted);

    if (picked.status !== "ok") {
        return picked;
    }

    const { driver } = dependencies;
    const { ref } = picked;

    return await readFromHost(driver, await dependencies.token(), async (request) => {
        const detail = await driver.getPullRequest(request, ref);
        const summary = await driver.listChecks(request, ref, detail.headSha, AGENT_MAX_CHECK_PAGES);
        const failing = summary.checks.filter((check) => FAILING.has(check.state));
        const checks: FailingCheck[] = [];
        const deadline = Date.now() + AGENT_LOG_READ_BUDGET_MS;

        // One log at a time: a log read is the heavy call, and the first few failures are what the agent needs.
        for (const [index, check] of failing.slice(0, AGENT_MAX_FAILING_CHECKS).entries()) {
            // Each log gets what is left of the read's one time budget; past it, the rest are named without one.
            const left = deadline - Date.now();
            const read = check.id !== null && index < AGENT_MAX_CHECK_LOGS && left >= AGENT_MIN_LOG_READ_MS;
            const log = read ? await driver.readCheckLog(request, ref, check.id!, LOG_EXCERPT_MAX_CHARS, left).catch(() => null) : null;

            checks.push({ id: check.id, log, logStatus: logStatusOf(read, log), name: check.name, required: check.required, url: check.url });
        }

        return {
            checks: { items: checks, ...truncatedMarker(failing.length - checks.length) },
            headSha: detail.headSha,
            passing: summary.checks.filter((check) => check.state === "success").length,
            pending: summary.checks.filter((check) => check.state === "pending").length,
            total: summary.total,
            // Checks the host has but did not list within the pages read: a failure may be among them.
            unlisted: { ...truncatedMarker(summary.total - summary.checks.length) },
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
): Promise<
    | AgentWriteOutcome<{ notRerun: string[]; rerun: RerunResult[]; skipped: string[]; unlisted: string[]; unlistedChecks: { truncated?: string } }>
    | { status: "head_moved" }
> => {
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

        // The same pages the failing-checks read lists, so a check it named can be re-run.
        return { headSha: detail.headSha, ...(await driver.listChecks(request, picked.ref, detail.headSha, AGENT_MAX_CHECK_PAGES)) };
    });

    if (listed.status !== "ok") {
        return listed;
    }

    const rerunnable = listed.checks.filter((check): check is CheckRun & { id: string } => check.id !== null && RERUNNABLE.has(check.state));
    // Unnamed, a call re-runs what failed; a cancelled check runs again only when it is named.
    const chosen = checkIds === undefined ? rerunnable.filter((check) => FAILING.has(check.state)) : rerunnable.filter((check) => checkIds.includes(check.id));
    // A named check the pages read do not list is not known to be anything: said so, rather than called skipped.
    const listedIds = new Set(listed.checks.flatMap((check) => (check.id === null ? [] : [check.id])));
    const complete = listed.checks.length >= listed.total;
    const missed = checkIds === undefined ? [] : checkIds.filter((id) => chosen.every((check) => check.id !== id));
    const skipped = missed.filter((id) => complete || listedIds.has(id));
    const unlisted = missed.filter((id) => !complete && !listedIds.has(id));
    // Past the cap, a check is named back rather than dropped: the agent can ask for it in a second call.
    const notRerun = chosen.slice(AGENT_MAX_RERUNS).map((check) => check.id);
    const rerun: RerunResult[] = [];

    // A push since the checks were listed makes them the old commit's: re-running those is not what was approved.
    const current = chosen.length === 0 ? null : await readFromHost(driver, token, async (request) => await driver.getPullRequest(request, picked.ref));

    if (current !== null && current.status !== "ok") {
        return current;
    }

    if (current !== null && current.headSha !== listed.headSha) {
        return { status: "head_moved" };
    }

    const batch = chosen.slice(0, AGENT_MAX_RERUNS);
    // Unnamed, every failed check is chosen, so a group's failed jobs (a workflow run's) re-run in ONE call: the host
    // refuses a second job of a run once the first runs again. Named checks re-run one by one, exactly as named.
    const groups = checkIds === undefined ? await rerunGroups(dependencies, token, picked.ref, batch) : new Map<string, typeof batch>();
    const grouped = new Set([...groups.values()].flat().map((check) => check.id));

    for (const [groupId, members] of groups) {
        const outcome = await writeToHost(driver, token, async (request) => {
            await driver.rerunFailedOfGroup!(request, picked.ref, groupId);

            return {};
        });

        for (const check of members) {
            rerun.push({ id: check.id, name: check.name, status: outcome.status, ...(outcome.status === "rejected" && { reason: outcome.reason }) });
        }
    }

    const alone = batch.filter((entry) => !grouped.has(entry.id));

    for (const check of alone) {
        const outcome = await writeToHost(driver, token, async (request) => {
            await driver.rerunCheck(request, picked.ref, check.id);

            return {};
        });

        rerun.push({ id: check.id, name: check.name, status: outcome.status, ...(outcome.status === "rejected" && { reason: outcome.reason }) });
    }

    // The host has more checks than the pages read: an unnamed re-run may have missed failed ones among them.
    return { notRerun, rerun, skipped, status: "ok", unlisted, unlistedChecks: { ...truncatedMarker(listed.total - listed.checks.length) } };
};

/**
 * The checks that re-run together, by group (a workflow run): two or more of them share it, AND the jobs the group's
 * call would re-run are exactly those checks. The host's call re-runs every failed or cancelled job of the run, so a
 * run with a job not chosen (past the cap, cancelled, on a page not read) re-runs its jobs one by one instead. A host
 * without groups, or a read that fails, groups nothing: each check then re-runs on its own.
 */
const rerunGroups = async <T extends { id: string }>(
    dependencies: PullRequestAgentDependencies,
    token: GithubTokenOutcome,
    ref: PullRequestRef,
    checks: T[],
): Promise<Map<string, T[]>> => {
    const { driver } = dependencies;

    if (driver.rerunGroupOf === undefined || driver.rerunFailedOfGroup === undefined || driver.rerunnableOfGroup === undefined || checks.length < 2) {
        return new Map();
    }

    const groupOf = driver.rerunGroupOf;
    const rerunnableOf = driver.rerunnableOfGroup;
    const read = await readFromHost(driver, token, async (request) => {
        const byGroup = new Map<string, T[]>();

        for (const check of checks) {
            const group = await groupOf(request, ref, check.id);

            if (group !== null) {
                byGroup.set(group, [...(byGroup.get(group) ?? []), check]);
            }
        }

        // Only a group whose call would re-run exactly the checks chosen, no more.
        const exact = new Map<string, T[]>();

        for (const [group, members] of byGroup) {
            const rerunnable = members.length > 1 ? await rerunnableOf(request, ref, group) : null;
            const chosen = new Set(members.map((member) => member.id));

            if (rerunnable !== null && rerunnable.length === chosen.size && rerunnable.every((id) => chosen.has(id))) {
                exact.set(group, members);
            }
        }

        return { exact };
    });

    return read.status === "ok" ? read.exact : new Map();
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
