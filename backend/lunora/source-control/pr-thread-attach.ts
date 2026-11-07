/**
 * Develop mode: attaching pull requests that already exist to a thread, by hand, and the lists a thread shows.
 *
 * The person names pull requests; each one is read from the host with their own connector first, so only a pull
 * request they can see is linked, and its branch names are the host's own text (a long one is cut short). The link is written by an
 * internal mutation, which checks the thread is the caller's own and not deleted. A pull request that is already
 * linked to the thread is named, not added twice.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery } from "../_generated/server";
import type { GithubTokenOutcome } from "../connectors/lib/github-token";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { isThreadLocked } from "../lib/thread-lock";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { linksFor, MAX_THREADS_PER_PULL_REQUEST, partitionLinks, pullRequestUrl, requireAddress, toOutput, vPullRequestThread } from "./pr-threads";
import { readFromHost } from "./read-host";

/** Pull requests one call may attach. Each one is a host read, so the list is short by design. */
const MAX_ATTACH_PER_CALL = 10;
/** Links one attach call keeps per thread, so its list stays a list. Agent-opened links are recorded past it (they are the agent's own record), so reads go wider. */
const MAX_LINKS_PER_THREAD = 20;
/** Link rows one thread's list reads: above the attach cap, so an agent-opened link past it still shows. */
const MAX_LINKS_READ_PER_THREAD = 100;
/** Threads one count read takes: the sidebar asks for the rows it shows, up to this many. */
const MAX_COUNT_THREADS = 200;
/** Link rows read per thread for its badge: above the attach cap, so a thread's badge is whole unless agents opened many more. */
const MAX_COUNT_ROWS_PER_THREAD = 25;

const vAddress = v.object({ number: v.number(), repository: v.string().max(MAX_LENGTH.key) });

const vAttachStatus = v.union(
    v.literal("attached"),
    v.literal("already_linked"),
    v.literal("forbidden"),
    v.literal("host_error"),
    v.literal("needs_reconnect"),
    v.literal("not_connected"),
    v.literal("not_found"),
    v.literal("rate_limited"),
    v.literal("pull_request_full"),
    v.literal("thread_full"),
);

const vAttachResult = v.object({ number: v.number(), repository: v.string(), status: vAttachStatus });

const fitText = (value: string | undefined): string | undefined => value?.slice(0, MAX_LENGTH.short);

const vVerifiedLink = v.object({
    baseBranch: v.optional(v.string().max(MAX_LENGTH.short)),
    headBranch: v.optional(v.string().max(MAX_LENGTH.short)),
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.key),
});

/** The host read said yes for these; the mutation decides which of them become rows. */
export const recordAttachedPullRequests = internalMutation
    .input({ links: v.array(vVerifiedLink), threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(vAttachResult))
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (!thread || thread.deleted === true) {
            throw new LunoraError("NOT_FOUND", "That thread is not there");
        }

        if (thread.userId !== args.userId) {
            throw new LunoraError("FORBIDDEN", "That thread belongs to someone else");
        }

        const results: { number: number; repository: string; status: "already_linked" | "attached" | "pull_request_full" | "thread_full" }[] = [];

        // Sequential on purpose: a pull request named twice in one call sees the row its first copy wrote.
        for (const link of args.links) {
            const address = requireAddress(link.repository, link.number);
            const { live } = await partitionLinks(ctx, await linksFor(ctx, args.userId, address.repository, address.number));

            if (live.some((row) => row.threadId === thread._id)) {
                results.push({ number: address.number, repository: address.repository, status: "already_linked" });

                continue;
            }

            if (live.length >= MAX_THREADS_PER_PULL_REQUEST) {
                results.push({ number: address.number, repository: address.repository, status: "pull_request_full" });

                continue;
            }

            const onThread = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_threadId", (q) => q.eq("userId", args.userId).eq("threadId", thread._id))
                .take(MAX_LINKS_PER_THREAD);

            if (onThread.length >= MAX_LINKS_PER_THREAD) {
                results.push({ number: address.number, repository: address.repository, status: "thread_full" });

                continue;
            }

            await ctx.db.insert("pullRequestThreads", {
                baseBranch: link.baseBranch,
                createdAt: ctx.now,
                headBranch: link.headBranch,
                kind: "linked",
                number: address.number,
                repository: address.repository,
                threadId: thread._id,
                // The thread's title, as every other kind of link stores it: the header and the Work-on list read this field.
                // A locked chat's title is its content: the row keeps the address instead, and a read shows the live title.
                title: isThreadLocked(thread)
                    ? `${address.repository}#${String(address.number)}`
                    : (thread.title ?? `${address.repository}#${String(address.number)}`),
                url: pullRequestUrl(address.repository, address.number),
                userId: args.userId,
            });

            results.push({ number: address.number, repository: address.repository, status: "attached" });
        }

        return results;
    });

/** The thread exists and is the caller's, checked before any host read so a refused request costs nothing. */
export const checkThreadForAttach = internalQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ ok: v.literal(true) }))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (!thread || thread.deleted === true) {
            throw new LunoraError("NOT_FOUND", "That thread is not there");
        }

        if (thread.userId !== args.userId) {
            throw new LunoraError("FORBIDDEN", "That thread belongs to someone else");
        }

        return { ok: true as const };
    });

/**
 * Attaches existing pull requests to one of your threads. Every one is read from the host first; a read the host
 * refuses is reported for that pull request and the rest still go through.
 */
export const attachPullRequests = authAction
    .use(rateLimit("sourceControl/write"))
    .input({
        pullRequests: v.array(vAddress).check((value) => value.length <= MAX_ATTACH_PER_CALL, { message: "Attach at most 10 pull requests at a time" }),
        threadId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ results: v.array(vAttachResult) }))
    .action(async ({ args, ctx }) => {
        if (args.pullRequests.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Attach between 1 and 10 pull requests at a time");
        }

        await ctx.runQuery(internal.source_control.pr_thread_attach.checkThreadForAttach, { threadId: args.threadId, userId: ctx.user.userId });

        // Every address is checked before the first host call, so a malformed one costs no reads.
        const addresses = args.pullRequests.map((pr) => requireAddress(pr.repository, pr.number));
        // A token renewed during one read is the one the next read starts from, so a batch refreshes it once.
        const remember = (outcome: GithubTokenOutcome): GithubTokenOutcome =>
            "problem" in outcome
                ? outcome
                : {
                      accessToken: outcome.accessToken,
                      renew: async () => {
                          token = remember(await outcome.renew());

                          return token;
                      },
                  };
        let token = remember(await resolveGithubToken(ctx, ctx.user.userId));
        const reads = [];

        for (const address of addresses) {
            reads.push({ address, outcome: await readFromHost(DEVELOP_DRIVER, token, (request) => DEVELOP_DRIVER.getPullRequest(request, address)) });
        }

        const verified = reads.flatMap(({ address, outcome }) =>
            outcome.status === "ok"
                ? [
                      {
                          // A name longer than the stored shape is cut short, rather than failing the batch.
                          baseBranch: fitText(outcome.baseBranch),
                          headBranch: fitText(outcome.headBranch),
                          number: address.number,
                          repository: address.repository,
                      },
                  ]
                : [],
        );
        const recorded =
            verified.length === 0
                ? []
                : await ctx.runMutation(internal.source_control.pr_thread_attach.recordAttachedPullRequests, {
                      links: verified,
                      threadId: args.threadId,
                      userId: ctx.user.userId,
                  });
        // `recorded` answers the verified reads in order, so a pull request named twice gets an answer for each copy.
        let nextRecorded = 0;

        ctx.log.event("source_control.attach_pull_requests", { count: args.pullRequests.length, verified: verified.length });

        return {
            results: reads.map(({ address, outcome }) => {
                if (outcome.status !== "ok") {
                    return { number: address.number, repository: address.repository, status: outcome.status };
                }

                const status = recorded[nextRecorded]?.status ?? "host_error";

                nextRecorded += 1;

                return { number: address.number, repository: address.repository, status };
            }),
        };
    });

/** Every pull request one thread is linked to, newest first: the ones it attached and the one a run opened it from. */
export const listForThread = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(vPullRequestThread))
    .query(async ({ args, ctx }) => {
        const rows = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", ctx.user.userId).eq("threadId", args.threadId as Id<"threads">))
            .take(MAX_LINKS_READ_PER_THREAD);
        const { live, threads } = await partitionLinks(ctx, rows);

        // A pull request that is linked twice to one thread (an agent's link and a hand link) is one entry, the newest.
        const seen = new Set<string>();
        const newestFirst = live.toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id));

        return newestFirst
            .filter((row) => {
                const key = `${row.repository}#${String(row.number)}`;
                const duplicate = seen.has(key);

                seen.add(key);

                return !duplicate;
            })
            .map((row) => toOutput(row, threads.get(row.threadId)));
    });

/**
 * How many pull requests each of the given threads is linked to, for the sidebar's badges: the sidebar asks once, for
 * the threads it shows, and each row reads its number from that one answer. Link rows only, a few per thread, so a
 * change to a thread or its size never re-runs or outgrows it; a thread past the per-thread read is left out, so its
 * badge is never a partial count. A deleted thread is not in the sidebar, and a link its soft delete flagged is not counted.
 */
export const countsForThreads = authQuery
    .input({
        threadIds: v
            .array(v.string().max(MAX_LENGTH.id))
            .check((value) => value.length <= MAX_COUNT_THREADS, { message: "Ask for at most 200 threads at a time" }),
    })
    .output(v.array(v.object({ count: v.number(), threadId: v.string() })))
    .query(async ({ args, ctx }) => {
        const counts: { count: number; threadId: string }[] = [];

        const threadIds = new Set(args.threadIds);

        for (const threadId of threadIds) {
            const rows = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_threadId", (q) => q.eq("userId", ctx.user.userId).eq("threadId", threadId as Id<"threads">))
                .take(MAX_COUNT_ROWS_PER_THREAD + 1);

            // Past the read, the number would be a part of the whole: that thread shows no badge rather than a wrong one.
            if (rows.length > MAX_COUNT_ROWS_PER_THREAD) {
                continue;
            }

            // A pull request counts once per thread, however many links name it.
            const distinct = new Set(rows.filter((row) => row.threadDeleted !== true).map((row) => `${row.repository}#${String(row.number)}`));

            if (distinct.size > 0) {
                counts.push({ count: distinct.size, threadId });
            }
        }

        return counts;
    });
