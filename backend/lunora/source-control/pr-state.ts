/**
 * The stored state of a thread's linked pull requests, which auto-archive reads (`agent/auto-archive.ts`): open, closed
 * or merged, as the host last said. Kept fresh by the housekeeping sweep on the user's own shard, never by a query.
 *
 * The sweep leases a bounded set of open links (stamping `stateCheckedAt` in the same transaction, so the next sweep
 * skips them) and schedules one action per link. The action asks the host with the person's token and records the
 * answer only while its lease is still the link's current one, so a late answer never overwrites a newer check.
 * A failed read leaves the state as it was. A 404 is not taken for a closed pull request: GitHub also answers it for a
 * private repository the token cannot see, and a closed link is never read again.
 * The sweep does nothing unless the person keeps open-pull-request chats and either auto-archive or merged-chat archiving is on.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
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
 * Links read per sweep: one page of the person's links. The scan moves to the next page after each sweep
 * (`pullRequestStateScans`), so a user with more links than this is reached one page per sweep.
 */
const SCAN_LIMIT = 500;
/** Links checked per sweep, so one user's host calls stay bounded. */
const CHECK_LIMIT = 20;
/** Thread lookups per sweep, as a multiple of `CHECK_LIMIT`: links on chats that are still active are skipped, within that bound. */
const THREAD_LOOKUP_FACTOR = 4;
/** Links read per chat when the sweep asks whether it owes a merge; a chat past this bound is checked rather than read further. */
const OWED_MERGE_LOOKUP_LIMIT = 100;
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

/**
 * A person linked a pull request again on purpose: a link the refresh recorded closed or merged is set open and unread
 * (`stateCheckedAt` 0), so the next sweep reads the host again and the chat is kept until that answer comes.
 */
export const rereadRelinkedLink = async (ctx: MutationCtx, link: Doc<"pullRequestThreads">): Promise<void> => {
    if (link.state === "closed" || link.state === "merged") {
        await ctx.db.patch("pullRequestThreads", link._id, { state: "open", stateCheckedAt: 0 });
    }
};

const vState = v.union(v.literal("open"), v.literal("closed"), v.literal("merged"));

/**
 * One page of the person's links at `cursor`. A cursor the server no longer reads (`INVALID_CURSOR`: minted by an older build)
 * restarts the scan from the first page, so a deployment does not stop the refresh for anyone.
 */
const linksPageAt = async (ctx: MutationCtx, userId: string, cursor: string | null) => {
    const links = () => ctx.db.query("pullRequestThreads").withIndex("by_user_and_repository_number", (q) => q.eq("userId", userId));

    try {
        return await links().paginate({ cursor, numItems: SCAN_LIMIT });
    } catch (error) {
        if (cursor === null || !(error instanceof LunoraError) || error.code !== "INVALID_CURSOR") {
            throw error;
        }

        return await links().paginate({ cursor: null, numItems: SCAN_LIMIT });
    }
};

/** Writes the scan position only when it moved, so a page that is still unfinished costs no write. */
const saveScan = async (ctx: MutationCtx, scan: Doc<"pullRequestStateScans"> | null, userId: string, cursor: string | null): Promise<void> => {
    if (!scan) {
        if (cursor !== null) {
            await ctx.db.insert("pullRequestStateScans", { cursor, userId });
        }

        return;
    }

    if (scan.cursor !== cursor) {
        await ctx.db.patch("pullRequestStateScans", scan._id, { cursor });
    }
};

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

        // The state is read by auto-archive (idle, or a merge the chat owes), so with neither on there is nothing to keep fresh.
        const days = settings?.autoArchiveAfterDays;
        const idleDays = isAutoArchiveDays(days) && days !== 0 ? days : undefined;
        const mergedOn = settings?.autoArchiveMergedChats === true && settings.autoArchiveMergedChatsSince !== undefined;

        if (!keepsOpenPullRequestChats(settings?.keepOpenPullRequestChats) || (idleDays === undefined && !mergedOn)) {
            return { dispatched: 0 };
        }

        const { now } = ctx;
        const scan = await ctx.db
            .query("pullRequestStateScans")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();
        const page = await linksPageAt(ctx, userId, scan?.cursor ?? null);
        // Never-checked first, then the longest unchecked: a link is not starved by the ones checked before it.
        const stale = page.page
            .filter(
                (link) =>
                    link.threadDeleted !== true &&
                    // An owed merge is a candidate too: its link reads merged, so only this lets a busy or failed archive retry in a later sweep.
                    (isOpenPullRequestForArchive(link) || (link.mergedAt !== undefined && link.mergeSettledAt === undefined)) &&
                    (link.stateCheckedAt === undefined || now - link.stateCheckedAt >= PR_STATE_MAX_AGE_MS),
            )
            .toSorted((a, b) => (a.stateCheckedAt ?? 0) - (b.stateCheckedAt ?? 0));
        const cutoff = idleDays === undefined ? undefined : autoArchiveCutoff(now, idleDays);
        const due: typeof stale = [];

        // Only a link whose chat auto-archive would consider idle, or whose chat owes a merge that can archive it, is read.
        const lookups = stale.slice(0, CHECK_LIMIT * THREAD_LOOKUP_FACTOR);
        // Several stale links can share a chat: its merge answer is read once per sweep, and only when idle archiving does not already due it.
        const owesMerge = new Map<string, boolean>();

        for (const link of lookups) {
            if (due.length >= CHECK_LIMIT) {
                break;
            }

            const thread = await ctx.db.get("threads", link.threadId);
            const idleDue = thread !== null && cutoff !== undefined && selectAutoArchiveDue([candidateOf(thread)], cutoff, NO_EXCLUSIONS, 1).length === 1;
            let mergeOwed = false;

            if (!idleDue && thread !== null && mergedOn) {
                const key = String(link.threadId);
                const known = owesMerge.get(key);

                mergeOwed = known ?? (await ownsMergeTo(ctx, userId, link.threadId));
                owesMerge.set(key, mergeOwed);
            }

            if (idleDue || mergeOwed) {
                due.push(link);
            } else {
                // Stamped as checked without a host read, so it moves behind the others instead of holding the front of the order.
                await ctx.db.patch("pullRequestThreads", link._id, { stateCheckedAt: now });
            }
        }

        // The scan moves to the next page after every sweep, so each page takes its turn. A link past this sweep's budget is
        // read on its page's next turn. Waiting on the same page until it drains would never end: a link checked now is stale
        // again ten minutes later, so a page with more open idle links than one sweep checks would never drain.
        await saveScan(ctx, scan, userId, page.isDone ? null : page.continueCursor);

        for (const link of due) {
            // Stamped first: a sweep that runs again before the read lands skips this link. The stamp is the lease.
            await ctx.db.patch("pullRequestThreads", link._id, { stateCheckedAt: now });
            await ctx.scheduler.runAfter(0, internal.source_control.pr_state.checkLinkedPullRequest, { lease: now, linkId: link._id });
        }

        return { dispatched: due.length };
    });

/** Whether the chat owes a merge: one recorded for it and not yet settled. */
const ownsMergeTo = async (ctx: MutationCtx, userId: string, threadId: Id<"threads">): Promise<boolean> => {
    // One bounded read per chat per sweep. A chat with more links than the bound may owe a merge past it, so it is checked (never
    // skipped): the sweep's host reads stay bounded, and an owed merge is not missed.
    const rows = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(OWED_MERGE_LOOKUP_LIMIT + 1);

    if (rows.length > OWED_MERGE_LOOKUP_LIMIT) {
        return true;
    }

    return rows.some((row) => row.mergedAt !== undefined && row.mergeSettledAt === undefined);
};

/**
 * A link just recorded as closed or merged makes its chat due for archive now, not at the next housekeeping pass: the sweep
 * read the chat's links before this answer. The job reads the owner's setting and the cutoff when it runs, so a setting
 * changed after this point decides it (`archiveClosedLinkChat`).
 */
export const scheduleArchiveAfterClose = async (ctx: { scheduler: MutationCtx["scheduler"] }, link: { threadId: Id<"threads"> }): Promise<void> => {
    await ctx.scheduler.runAfter(0, internal.agent.auto_archive.archiveClosedLinkChat, { threadId: link.threadId });
};

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
        // A merge recorded on the link is final: an older check that still reads it open cannot undo it before the archive runs.
        const recordedMerged = link !== null && (link.mergedAt !== undefined || link.state === "merged");

        if (link !== null && link.stateCheckedAt === args.lease && !(recordedMerged && args.state === "open")) {
            await ctx.db.patch("pullRequestThreads", link._id, { state: args.state, stateCheckedAt: ctx.now });

            if (args.state !== "open") {
                await scheduleArchiveAfterClose(ctx, link);
            }
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
