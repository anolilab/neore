/**
 * The stored state of a thread's linked pull requests, which auto-archive reads (`agent/auto-archive.ts`): open, closed
 * or merged, as the host last said. Kept fresh by the housekeeping sweep on the user's own shard, never by a query.
 *
 * The sweep leases a bounded set of open links (stamping `stateCheckedAt` in the same transaction, so the next sweep
 * skips them) and schedules one action per link. The action asks the host with the person's token and records the
 * answer only while its lease is still the link's current one, so a late answer never overwrites a newer check.
 * A failed read leaves the state as it was. A 404 is not taken for a closed pull request: GitHub also answers it for a
 * private repository the token cannot see, and a closed link is never read again.
 * The sweep does nothing unless auto-archive is on and the person keeps open-pull-request chats.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import {
    autoArchiveCutoff,
    type AutoArchiveCandidate,
    isAutoArchiveDays,
    isOpenPullRequestForArchive,
    keepsOpenPullRequestChats,
    selectAutoArchiveDue,
} from "../agent/auto-archive-logic";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { currentUserShard } from "../lib/shard-context";
import { DEVELOP_DRIVER } from "./develop-driver";
import { readFromHost } from "./read-host";

/** A link's state is re-read once it is this old. */
export const PR_STATE_MAX_AGE_MS = 10 * 60 * 1000;
/**
 * Links read per sweep. The candidates are checked oldest-first, so a link past this window is reached as soon as the
 * links ahead of it are fresh; only a user with more links than this waits longer.
 */
const SCAN_LIMIT = 500;
/** Links checked per sweep, so one user's host calls stay bounded. */
const CHECK_LIMIT = 20;
/** Thread lookups per sweep, as a multiple of `CHECK_LIMIT`: links on chats that are still active are skipped, within that bound. */
const THREAD_LOOKUP_FACTOR = 4;
/** Auto-archive's idle rule alone. Its live-stream and pinned-project exclusions are left out, so a chat that is then kept still gets a read. */
const NO_EXCLUSIONS = { liveThreadIds: new Set<string>(), pinnedProjectIds: new Set<string>() };

const candidateOf = (thread: {
    _id: string;
    deleted?: boolean;
    isTemporary?: boolean;
    pinnedAt?: number;
    projectId?: string;
    status: string;
    updatedAt?: number;
}): AutoArchiveCandidate => {
    return {
        _id: thread._id,
        deleted: thread.deleted,
        isTemporary: thread.isTemporary,
        pinnedAt: thread.pinnedAt,
        projectId: thread.projectId,
        status: thread.status,
        updatedAt: thread.updatedAt,
    };
};

const vState = v.union(v.literal("open"), v.literal("closed"), v.literal("merged"));

/** Shard sweep: leases the open links whose state is stale, oldest check first, and schedules one host read for each. */
export const dispatchLinkedPullRequestChecks = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId === undefined) {
            return { dispatched: 0 };
        }

        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        // The state is only read by auto-archive, so with auto-archive off there is nothing to keep fresh.
        const days = settings?.autoArchiveAfterDays;

        if (!isAutoArchiveDays(days) || days === 0 || !keepsOpenPullRequestChats(settings?.keepOpenPullRequestChats)) {
            return { dispatched: 0 };
        }

        const { now } = ctx;
        const links = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_repository_number", (q) => q.eq("userId", userId))
            .take(SCAN_LIMIT);
        // Never-checked first, then the longest unchecked: a link is not starved by the ones checked before it.
        const stale = links
            .filter(
                (link) =>
                    link.threadDeleted !== true &&
                    isOpenPullRequestForArchive(link) &&
                    (link.stateCheckedAt === undefined || now - link.stateCheckedAt >= PR_STATE_MAX_AGE_MS),
            )
            .toSorted((a, b) => (a.stateCheckedAt ?? 0) - (b.stateCheckedAt ?? 0));
        const cutoff = autoArchiveCutoff(now, days);
        const due: typeof stale = [];

        // Only a link whose chat auto-archive would consider idle is read: the state of any other chat is never used.
        const lookups = stale.slice(0, CHECK_LIMIT * THREAD_LOOKUP_FACTOR);

        for (const link of lookups) {
            if (due.length >= CHECK_LIMIT) {
                break;
            }

            const thread = await ctx.db.get("threads", link.threadId);

            if (thread !== null && selectAutoArchiveDue([candidateOf(thread)], cutoff, NO_EXCLUSIONS, 1).length === 1) {
                due.push(link);
            }
        }

        for (const link of due) {
            // Stamped first: a sweep that runs again before the read lands skips this link. The stamp is the lease.
            await ctx.db.patch("pullRequestThreads", link._id, { stateCheckedAt: now });
            await ctx.scheduler.runAfter(0, internal.source_control.pr_state.checkLinkedPullRequest, { lease: now, linkId: link._id });
        }

        return { dispatched: due.length };
    });

/** What the host read needs from a link, read on the user's shard. Null when the link is gone. */
export const readLinkForStateCheck = internalQuery
    .input({ linkId: v.id("pullRequestThreads") })
    .output(v.union(v.null(), v.object({ number: v.number(), repository: v.string(), userId: v.string() })))
    .query(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        return link === null ? null : { number: link.number, repository: link.repository, userId: link.userId };
    });

/**
 * Records what the host said about a link, but only while `lease` is still the link's current check: a result from an
 * older check that lands after a newer one is dropped.
 */
export const recordLinkState = internalMutation
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads"), state: vState })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const link = await ctx.db.get("pullRequestThreads", args.linkId);

        if (link !== null && link.stateCheckedAt === args.lease) {
            await ctx.db.patch("pullRequestThreads", link._id, { state: args.state, stateCheckedAt: ctx.now });
        }

        return null;
    });

/** One host read for one link, with the person's own token. */
export const checkLinkedPullRequest = internalAction
    .input({ lease: v.number(), linkId: v.id("pullRequestThreads") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const target = await ctx.runQuery(internal.source_control.pr_state.readLinkForStateCheck, { linkId: args.linkId });

        if (target === null) {
            return null;
        }

        const token = await resolveGithubToken(ctx, target.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const detail = await DEVELOP_DRIVER.getPullRequest(request, { number: target.number, repository: target.repository });

            return { state: detail.state };
        });

        if (outcome.status === "ok") {
            await ctx.runMutation(internal.source_control.pr_state.recordLinkState, { lease: args.lease, linkId: args.linkId, state: outcome.state });
        }

        return null;
    });
