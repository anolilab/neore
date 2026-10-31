/**
 * Develop mode: the threads a pull request is worked on in, linked both ways.
 *
 * A person starts on a pull request ("Work on this PR") and gets a thread with it attached, as its first turn; a coding
 * agent that opens one from a thread records it here, so the pull request lists the threads that worked on it and the
 * thread names the pull request it opened. `pullRequestThreads` is the link, one row per side.
 *
 * Every row is the caller's own, stamped from `ctx.user`. The address is checked against the driver's own repository
 * rules, and the URL is BUILT here from the host's web origin rather than taken from a client — a link the user clicks
 * cannot be pointed somewhere else.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { addMessagesHandler } from "../agent/messages";
import { insertThread } from "../agent/table-writes";
import { isValidBranchName } from "../coding-agents/commands";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { GITHUB_WEB_ORIGIN, splitGithubRepo } from "./drivers/github";

/** Threads kept per pull request: a list, not a history. The newest are the ones anyone is working in. */
const MAX_THREADS_PER_PULL_REQUEST = 50;

const MAX_TITLE_CHARS = 200;

const vPullRequestThread = v.object({
    baseBranch: v.optional(v.string()),
    createdAt: v.number(),
    headBranch: v.optional(v.string()),
    kind: v.union(v.literal("attached"), v.literal("opened")),
    number: v.number(),
    repository: v.string(),
    threadId: v.string(),
    title: v.string(),
    url: v.string(),
});

type PullRequestThread = Doc<"pullRequestThreads">;

/** The row as the client reads it. Never the owner column: it is the caller's own by construction. */
const toOutput = (row: PullRequestThread) => {
    return {
        ...(row.baseBranch !== undefined && { baseBranch: row.baseBranch }),
        createdAt: row.createdAt,
        ...(row.headBranch !== undefined && { headBranch: row.headBranch }),
        kind: row.kind,
        number: row.number,
        repository: row.repository,
        threadId: row.threadId,
        title: row.title,
        url: row.url,
    };
};

/** An address the host's own rules accept: `owner/name` and a whole number from 1. */
const requireAddress = (repo: string, number: number): { number: number; repository: string } => {
    if (!splitGithubRepo(repo)) {
        throw new LunoraError("BAD_REQUEST", "Not a repository address this host serves");
    }

    if (!Number.isSafeInteger(number) || number < 1) {
        throw new LunoraError("BAD_REQUEST", "Not a pull request number");
    }

    return { number, repository: repo };
};

const requireBranch = (branch: string | undefined): string | undefined => {
    if (branch === undefined) {
        return undefined;
    }

    if (!isValidBranchName(branch)) {
        throw new LunoraError("BAD_REQUEST", "Not a branch name");
    }

    return branch;
};

/** The pull request's page on the host: built from the host's origin, never taken from a client. */
const pullRequestUrl = (repo: string, number: number): string => `${GITHUB_WEB_ORIGIN}/${repo}/pull/${String(number)}`;

const linksFor = async (ctx: QueryCtx | MutationCtx, userId: string, repo: string, number: number): Promise<PullRequestThread[]> =>
    await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_repository_number", (q) => q.eq("userId", userId).eq("repository", repo).eq("number", number))
        .take(MAX_THREADS_PER_PULL_REQUEST);

/**
 * "Work on this PR": a thread of yours with the pull request attached, as its first turn. The second click attaches
 * nothing and opens nothing — it names the thread already working on it, so a double click cannot make two.
 */
export const startWorkOnPullRequest = authMutation
    .use(rateLimit("sourceControl/write"))
    .input({
        baseBranch: v.optional(v.string().max(MAX_LENGTH.short)),
        headBranch: v.optional(v.string().max(MAX_LENGTH.short)),
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.key),
    })
    .output(v.object({ created: v.boolean(), threadId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const address = requireAddress(args.repository, args.number);
        const baseBranch = requireBranch(args.baseBranch);
        const headBranch = requireBranch(args.headBranch);
        const { userId } = ctx.user;
        const links = await linksFor(ctx, userId, address.repository, address.number);
        const attached = links.find((row) => row.kind === "attached");

        if (attached) {
            return { created: false, threadId: attached.threadId };
        }

        const title = `Work on ${address.repository}#${String(address.number)}`.slice(0, MAX_TITLE_CHARS);
        const url = pullRequestUrl(address.repository, address.number);
        const { now } = ctx;
        const threadId = await insertThread(ctx.db, {
            createdBy: userId,
            mode: "text",
            status: "active",
            tags: ["chat", "develop"],
            title,
            updatedAt: now,
            userId,
        });

        // The pull request is the thread's first turn: the agent that reads it knows what it is working on.
        await addMessagesHandler(ctx, {
            fromUser: true,
            messages: [{ message: { content: `Work on this pull request: ${url}`, role: "user" }, status: "success" }],
            threadId,
            userId,
        });

        await ctx.db.insert("pullRequestThreads", {
            ...(baseBranch !== undefined && { baseBranch }),
            createdAt: now,
            ...(headBranch !== undefined && { headBranch }),
            kind: "attached",
            number: address.number,
            repository: address.repository,
            threadId,
            title,
            url,
            userId,
        });

        return { created: true, threadId };
    });

/** Every thread working on one pull request, newest first. Both kinds: the one you started and the ones a run opened it from. */
export const listForPullRequest = authQuery
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.key) })
    .output(v.array(vPullRequestThread))
    .query(async ({ args, ctx }) => {
        const address = requireAddress(args.repository, args.number);
        const rows = await linksFor(ctx, ctx.user.userId, address.repository, address.number);

        // Newest first; the id breaks a tie so two rows saved in the same millisecond still read in one order.
        return rows.toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id)).map((row) => toOutput(row));
    });

/** The pull request one thread was attached to or opened, or `null` for a thread that has none. */
export const getForThread = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vPullRequestThread, v.null()))
    .query(async ({ args, ctx }) => {
        const row = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", ctx.user.userId).eq("threadId", args.threadId as Id<"threads">))
            .first();

        return row === null ? null : toOutput(row);
    });

/** `https://<host>/<owner>/<name>/pull/<number>`, and nothing else. */
const GITHUB_PULL_REQUEST_PATH = /^([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,12})$/u;

const parsePullRequestUrl = (prUrl: string): { number: number; repository: string } => {
    const prefix = `${GITHUB_WEB_ORIGIN}/`;

    if (!prUrl.startsWith(prefix)) {
        throw new LunoraError("BAD_REQUEST", "Not a pull request on this host");
    }

    const match = GITHUB_PULL_REQUEST_PATH.exec(prUrl.slice(prefix.length));
    const [, owner, name, raw] = match ?? [];

    if (owner === undefined || name === undefined || raw === undefined) {
        throw new LunoraError("BAD_REQUEST", "Not a pull request address");
    }

    return requireAddress(`${owner}/${name}`, Number(raw));
};

/**
 * A coding agent opened a pull request from this thread. Internal: the run reports it, so nobody can attach a pull
 * request to a thread that did not open it — and the thread must be the run owner's own.
 */
export const recordOpenedPullRequest = internalMutation
    .input({ prUrl: v.string().max(MAX_LENGTH.url), threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ created: v.boolean(), threadId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const address = parsePullRequestUrl(args.prUrl);
        const thread = await ctx.db.get(args.threadId as Id<"threads">);

        if (!thread) {
            throw new LunoraError("NOT_FOUND", "That thread is not there");
        }

        if (thread.userId !== args.userId) {
            throw new LunoraError("FORBIDDEN", "That thread belongs to someone else");
        }

        const openedLinks = await linksFor(ctx, args.userId, address.repository, address.number);
        const opened = openedLinks.find((row) => row.kind === "opened");

        if (opened) {
            return { created: false, threadId: opened.threadId };
        }

        await ctx.db.insert("pullRequestThreads", {
            createdAt: ctx.now,
            kind: "opened",
            number: address.number,
            repository: address.repository,
            threadId: args.threadId as Id<"threads">,
            title: thread.title ?? `${address.repository}#${String(address.number)}`,
            url: pullRequestUrl(address.repository, address.number),
            userId: args.userId,
        });

        return { created: true, threadId: args.threadId };
    });
