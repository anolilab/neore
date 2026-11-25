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
import { internalMutation, internalQuery } from "../_generated/server";
import { addMessagesHandler } from "../agent/messages";
import { insertThread } from "../agent/table-writes";
import { isValidBranchName } from "../coding-agents/commands";
import { callerRestrictsFull, ownerNewChatMode } from "../chat/lib/new-chat-mode";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { isThreadLocked, LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import { MAX_LENGTH } from "../lib/validators";
import { GITHUB_WEB_ORIGIN, splitGithubRepo } from "./drivers/github";
import { rereadRelinkedLink, scheduleArchiveAfterClose } from "./pr-state";
import { MERGE_TIME_PRECISION_MS, noteMergeAttemptRow, pullRequestLinksOf, settleMergedLinkRow, someLinkOfThread } from "./pr-thread-links";

/** Threads kept per pull request: a list, not a history. The newest are the ones anyone is working in. */
export const MAX_THREADS_PER_PULL_REQUEST = 50;
/**
 * Link rows read for one pull request. Above the live cap: links to deleted threads stay as rows, and they must not fill the
 * read and hide a link that was just made.
 */
const MAX_LINKS_READ_PER_PULL_REQUEST = 200;

const MAX_TITLE_CHARS = 200;

export const vPullRequestThread = v.object({
    baseBranch: v.optional(v.string()),
    createdAt: v.number(),
    headBranch: v.optional(v.string()),
    kind: v.union(v.literal("attached"), v.literal("linked"), v.literal("opened")),
    number: v.number(),
    repository: v.string(),
    statusReadAt: v.optional(v.number()),
    threadId: v.string(),
    title: v.string(),
    url: v.string(),
});

type PullRequestThread = Doc<"pullRequestThreads">;

/**
 * The title a link shows: the chat's current one, and none of it while the chat is locked, whatever the row stored.
 * Without the thread read, the stored title.
 */
export const shownTitle = (row: PullRequestThread, thread: Pick<Doc<"threads">, "lockedAt" | "title"> | null | undefined): string => {
    if (!thread) {
        return row.title;
    }

    return isThreadLocked(thread) ? LOCKED_THREAD_TITLE : (thread.title ?? row.title);
};

/** The row as the client reads it. Never the owner column: it is the caller's own by construction. */
export const toOutput = (row: PullRequestThread, thread?: Pick<Doc<"threads">, "lockedAt" | "title"> | null) => {
    return {
        ...(row.baseBranch !== undefined && { baseBranch: row.baseBranch }),
        createdAt: row.createdAt,
        ...(row.headBranch !== undefined && { headBranch: row.headBranch }),
        kind: row.kind,
        number: row.number,
        repository: row.repository,
        ...(row.statusReadAt !== undefined && { statusReadAt: row.statusReadAt }),
        threadId: row.threadId,
        title: shownTitle(row, thread),
        url: row.url,
    };
};

/** An address the host's own rules accept: `owner/name` and a whole number from 1. */
export const requireAddress = (repo: string, number: number): { number: number; repository: string } => {
    if (!splitGithubRepo(repo)) {
        throw new LunoraError("BAD_REQUEST", "Not a repository address this host serves");
    }

    if (!Number.isSafeInteger(number) || number < 1) {
        throw new LunoraError("BAD_REQUEST", "Not a pull request number");
    }

    // The host does not tell `Octo/Hello` from `octo/hello`, so neither do the links.
    return { number, repository: repo.toLowerCase() };
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
export const pullRequestUrl = (repo: string, number: number): string => `${GITHUB_WEB_ORIGIN}/${repo}/pull/${String(number)}`;

export const linksFor = async (ctx: QueryCtx | MutationCtx, userId: string, repo: string, number: number): Promise<PullRequestThread[]> =>
    await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_repository_number", (q) => q.eq("userId", userId).eq("repository", repo).eq("number", number))
        .take(MAX_LINKS_READ_PER_PULL_REQUEST);

/** The links whose thread is still there and not deleted; a link to one that is not is dead. */
export const partitionLinks = async (
    ctx: QueryCtx | MutationCtx,
    rows: PullRequestThread[],
): Promise<{ dead: PullRequestThread[]; live: PullRequestThread[]; threads: ReadonlyMap<string, Doc<"threads"> | null> }> => {
    const dead: PullRequestThread[] = [];
    const live: PullRequestThread[] = [];
    // Several links can sit on one thread: read each thread once per call.
    const threads = new Map<string, Doc<"threads"> | null>();

    for (const row of rows) {
        if (!threads.has(row.threadId)) {
            threads.set(row.threadId, await ctx.db.get("threads", row.threadId));
        }

        const thread = threads.get(row.threadId);

        (thread && thread.deleted !== true ? live : dead).push(row);
    }

    return { dead, live, threads };
};

/**
 * "Work on this PR": a thread of yours with the pull request attached, as its first turn. The second click attaches
 * nothing and opens nothing — it names the thread already working on it, so a double click cannot make two.
 */
export const startWorkOnPullRequest = authMutation
    .use(rateLimit("chat/create"))
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
        const { dead, live } = await partitionLinks(ctx, await linksFor(ctx, userId, address.repository, address.number));
        const attached = live.find((row) => row.kind === "attached");

        // A thread that was deleted leaves its link behind (a soft delete does); clear it and start fresh.
        const deadAttached = dead.filter((row) => row.kind === "attached");

        for (const link of deadAttached) {
            await ctx.db.delete("pullRequestThreads", link._id);
        }

        if (attached) {
            await rereadRelinkedLink(ctx, attached);
            ctx.log.event("source_control.start_work_on_pull_request", { clearedDeadLinks: deadAttached.length, created: false });

            return { created: false, threadId: attached.threadId };
        }

        const title = `Work on ${address.repository}#${String(address.number)}`.slice(0, MAX_TITLE_CHARS);
        const url = pullRequestUrl(address.repository, address.number);
        const { now } = ctx;
        // A new chat starts in the owner's default mode (`ownerNewChatMode`), read before the thread is written.
        const permissionMode = await ownerNewChatMode(ctx, userId, () => callerRestrictsFull(ctx));
        const threadId = await insertThread(ctx.db, {
            createdBy: userId,
            mode: "text",
            ...(permissionMode && { permissionMode }),
            status: "active",
            tags: ["chat", "develop"],
            title,
            updatedAt: now,
            userId,
        });
        const created = await ctx.db.get("threads", threadId);

        // The same audit record any other new thread gets (`chat.createThread`, through `lib/document-history.ts`).
        if (created) {
            await ctx.db.insert("documentHistory", {
                attribution: { action: "insert", source: "manual" },
                doc: created,
                documentId: threadId,
                isDeleted: false,
                tableName: "threads",
                ts: now,
                userId,
            });
        }

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

        ctx.log.event("source_control.start_work_on_pull_request", { clearedDeadLinks: deadAttached.length, created: true });

        return { created: true, threadId };
    });

/** Every thread working on one pull request, newest first. Both kinds: the one you started and the ones a run opened it from. */
export const listForPullRequest = authQuery
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.key) })
    .output(v.array(vPullRequestThread))
    .query(async ({ args, ctx }) => {
        const address = requireAddress(args.repository, args.number);
        const { live: rows, threads } = await partitionLinks(ctx, await linksFor(ctx, ctx.user.userId, address.repository, address.number));

        // Newest first; the id breaks a tie so two rows saved in the same millisecond still read in one order.
        return rows
            .toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id))
            .map((row) => toOutput(row, threads.get(row.threadId)));
    });

/** The pull request one thread was attached to or opened, or `null` for a thread that has none. */
export const getForThread = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vPullRequestThread, v.null()))
    .query(async ({ args, ctx }) => {
        const rows = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", ctx.user.userId).eq("threadId", args.threadId as Id<"threads">))
            .take(MAX_THREADS_PER_PULL_REQUEST);
        // A thread can hold a few links (it attached one pull request and opened another): the newest speaks for it.
        const row = rows.toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id))[0] ?? null;

        if (row === null) {
            return null;
        }

        const { live, threads } = await partitionLinks(ctx, [row]);

        return live.length === 0 ? null : toOutput(row, threads.get(row.threadId));
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
        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (!thread || thread.deleted === true) {
            throw new LunoraError("NOT_FOUND", "That thread is not there");
        }

        if (thread.userId !== args.userId) {
            throw new LunoraError("FORBIDDEN", "That thread belongs to someone else");
        }

        const openedLinks = await linksFor(ctx, args.userId, address.repository, address.number);
        const { live: openedLive } = await partitionLinks(ctx, openedLinks);
        const opened = openedLive.find((row) => row.kind === "opened");

        if (opened) {
            return { created: false, threadId: opened.threadId };
        }

        await ctx.db.insert("pullRequestThreads", {
            createdAt: ctx.now,
            kind: "opened",
            number: address.number,
            repository: address.repository,
            threadId: args.threadId as Id<"threads">,
            // A locked chat's title is its content: the row keeps the address instead, and a read shows the live title.
            title: isThreadLocked(thread)
                ? `${address.repository}#${String(address.number)}`
                : (thread.title ?? `${address.repository}#${String(address.number)}`),
            url: pullRequestUrl(address.repository, address.number),
            userId: args.userId,
        });

        return { created: true, threadId: args.threadId };
    });

/** A link stamped this recently is not rewritten by a repeat view: it already sits at the back of the rotation. */
const STATUS_STAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Stamps the links to one pull request as read from the host, now. The chat header reads the least recently read links
 * first, so every link is reached over the views of its chat. The address is canonical (the caller canonicalizes it).
 */
export const recordStatusRead = internalMutation
    .input({
        number: v.number(),
        /** When the host was asked: a link created after it was not part of that read, so it is not stamped. */
        readStartedAt: v.optional(v.number()),
        repository: v.string().max(MAX_LENGTH.short),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // Only the viewing chat's own links are stamped, so they are read through that chat's index, paged, and the pull
        // request's other links are never touched.
        await someLinkOfThread(ctx, args.userId, args.threadId as Id<"threads">, async (link) => {
            if (link.repository !== args.repository || link.number !== args.number) {
                return false;
            }

            // A row stamped inside the window already sits at the back of the rotation: a repeat view does not rewrite it.
            const stampedRecently = link.statusReadAt !== undefined && ctx.now - link.statusReadAt < STATUS_STAMP_WINDOW_MS;

            // A link made after the host was asked was not part of its answer, so it is not marked as read.
            const madeAfterRead = args.readStartedAt !== undefined && link.createdAt > args.readStartedAt;

            if (!stampedRecently && !madeAfterRead) {
                await ctx.db.patch("pullRequestThreads", link._id, { statusReadAt: ctx.now });
            }

            return false;
        });

        return null;
    });

/**
 * Notes that an owed link's archive attempt failed before it could answer, so the next read's batch reaches the other owed
 * chats first. Internal: the caller runs it after the attempt's own transaction rolled back, so only the stamp is written.
 */
export const noteMergeAttempt = internalMutation
    .input({ linkId: v.id("pullRequestThreads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await noteMergeAttemptRow(ctx, args.linkId, ctx.now);

        return null;
    });

/**
 * The owner's links to a pull request read merged, when the host says so without a merge time. The state is all it writes: no merge is
 * recorded, so nothing archives for it. Internal: called by the status read for the owner only.
 */
export const noteLinksMerged = internalMutation
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.short), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const links = await pullRequestLinksOf(ctx, args.userId, args.repository, args.number);

        for (const link of links) {
            if (link.state === "merged") {
                continue;
            }

            await ctx.db.patch("pullRequestThreads", link._id, { state: "merged" });
            // A link that just became closed or merged may let an idle chat archive, so its archive job runs now (as recordLinkState does).
            await scheduleArchiveAfterClose(ctx, link);
        }

        return null;
    });

/** Whether the owner's merged-chat archiving is on, so a merge can be ordered against its opt-in: the merge action reads the host's time only then. */
export const mergedArchiveOn = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .unique();

        return settings?.autoArchiveMergedChats === true && settings.autoArchiveMergedChatsSince !== undefined;
    });

/**
 * Records that a pull request was seen merged, on each link made before the merge. Internal: called by the merge action
 * and the status read, both with the merge time (the host's, or the time before the merge request), so a link made after
 * the merge is neither marked nor returned. Returns the links still owed an archive attempt for this merge: ones just
 * marked, and ones marked by an earlier read whose attempt never settled.
 */
export const recordPullRequestMerged = internalMutation
    .input({
        /** The merge's lower-bound time: the setting's opt-in is compared with it. */
        mergedAt: v.optional(v.number()),
        /** The merge's upper-bound time: a link created at or after it was not part of the merge. Absent: `mergedAt` plus a second. */
        mergedBefore: v.optional(v.number()),
        /** False when `mergedBefore` is not the host's bound (the host gave no merge time): it orders the links, but it is not stored. */
        mergedBeforeIsHostBound: v.optional(v.boolean()),
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.short),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.array(v.object({ linkId: v.id("pullRequestThreads"), threadId: v.id("threads") })))
    .mutation(async ({ args, ctx }) => {
        const mergedAt = args.mergedAt ?? ctx.now;
        const mergedBefore = args.mergedBefore ?? mergedAt + MERGE_TIME_PRECISION_MS;
        const owed: { lastAttemptAt: number; linkId: Id<"pullRequestThreads">; threadId: Id<"threads"> }[] = [];
        const links = await pullRequestLinksOf(ctx, args.userId, args.repository, args.number);
        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .unique();
        const since = settings?.autoArchiveMergedChatsSince;
        const settingOn = settings?.autoArchiveMergedChats === true && since !== undefined;

        for (const link of links) {
            if (link.mergedAt === undefined) {
                if (link.createdAt >= mergedBefore) {
                    // Made after the merge, so it owes no archive; the host's merge still holds for its pull request, so its state
                    // says merged and it does not keep another chat open (`pr-state.ts`).
                    if (link.state !== "merged") {
                        await ctx.db.patch("pullRequestThreads", link._id, { state: "merged" });
                    }

                    continue;
                }

                // The host's merge time when the read had it, else now: the export shows when the merge happened, not when it was seen.
                // The host said merged: the link's state says so too, so the open-pull-request rule (`pr-state.ts`) no longer keeps its chat.
                // The bound is stored only when the host gave the merge time: a bound made from the request time says nothing about when
                // the merge happened, so the reopen guard must not decline on it.
                const storeBound = args.mergedBeforeIsHostBound !== false;

                await ctx.db.patch("pullRequestThreads", link._id, {
                    mergedAt,
                    state: "merged",
                    ...(storeBound && { mergedBefore }),
                });
            } else {
                // A link marked earlier keeps its merge time. A relink may have reset its state to open, but the host's merge still
                // holds, so the state is restored before the link is skipped or judged.
                if (link.state !== "merged") {
                    await ctx.db.patch("pullRequestThreads", link._id, { state: "merged" });
                }

                if (link.mergeSettledAt !== undefined) {
                    continue;
                }
            }

            // Judged on the link's own merge time, once stored: a later read with a less precise time cannot retract a merge that
            // already proved it came after the opt-in. With the setting off (or the merge before the opt-in), the link settles here,
            // so a later opt-in cannot archive a chat for a merge that came before it.
            const eligibleAt = link.mergedAt ?? mergedAt;

            if (!settingOn || since === undefined || eligibleAt < since) {
                await settleMergedLinkRow(ctx, link._id, ctx.now);
                continue;
            }

            owed.push({ lastAttemptAt: link.mergeAttemptedAt ?? 0, linkId: link._id, threadId: link.threadId });
        }

        // Least recently attempted first: a read's bounded batch reaches every owed chat, not just the first busy ones.
        owed.sort((a, b) => a.lastAttemptAt - b.lastAttemptAt);

        return owed.map((link) => {
            return { linkId: link.linkId, threadId: link.threadId };
        });
    });
