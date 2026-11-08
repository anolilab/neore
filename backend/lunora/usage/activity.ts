/**
 * The usage page's activity heatmap and per-skill breakdown.
 *
 * Both read `usageDaily`, a per-day rollup on the user's shard fed once per
 * reply through {@link recordReplyUsage}: by `afterRun` (`chat/lib/agent-run.ts`)
 * for interactive replies and group-chat speakers, by `runHeadlessAgent` for
 * tasks, triggers, evals, sub-agents and messenger replies, and by the Daily
 * Brief. Replies from before the rollup existed are filled in by the backfill
 * (`backfill.ts`). Never a scan of the user's messages: the heatmap reads at
 * most {@link HEATMAP_DAYS} total rows, the breakdown at most
 * {@link BREAKDOWN_ROW_LIMIT} per-skill rows, both through an index on
 * `(userId, …, date)`.
 *
 * A reply is counted once: `usageReplies` holds the key of every reply in the
 * rollup, so a redelivered record — or one the backfill already counted — adds
 * nothing.
 *
 * A reply in a thread that belongs to a project is also filed under that
 * project, as the thread stands when the record lands; moving the thread later
 * leaves its earlier usage where it was.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authQuery } from "../lib/crpc";
import { logger } from "../lib/logger";
import { runAfterOnShard, runAfterWithRetry } from "../lib/shard-scheduler";
import { readableProject } from "../projects/functions";
import { leadThreadOf } from "../sub-agents/worker-thread";
import type { Attribution, AttributionIncrement, ReplyUsageArgs, RollupIncrement } from "./activity-logic";
import {
    addDays,
    attributionRows,
    BREAKDOWN_ROW_LIMIT,
    foldDayTotals,
    foldSkillTotals,
    HEATMAP_DAYS,
    isDayKey,
    PROJECT_SKILL_KEY,
    RECORD_RETRY,
    RETRY_COUNTS_WITHIN_MS,
    TOTAL_SKILL_KEY,
    withDayTotals,
} from "./activity-logic";

const usageLogger = logger.scope("usage");

/** A `YYYY-MM-DD` argument, refused at the boundary when it is anything else. */
const vDayKey = () => v.string().check(isDayKey, { message: "Expected a YYYY-MM-DD date", schema: { maxLength: 10, minLength: 10 } });

/** `skillKey`s the rollup keeps for itself; a reply never records under one. */
const RESERVED_SKILL_KEYS = new Set([PROJECT_SKILL_KEY, TOTAL_SKILL_KEY]);

type DbCtx = Pick<MutationCtx, "db">;

/** A context that only reads. */
type ReadCtx = Pick<MutationCtx | QueryCtx, "db">;

/** Whether the reply keyed `replyKey` is already in the user's rollup. */
export const isReplyRecorded = async (ctx: DbCtx, userId: string, replyKey: string): Promise<boolean> =>
    (await ctx.db.usageReplies.findFirst({ where: { replyKey, userId } })) !== null;

/** `withoutProject`: the reply was counted while its project could not be read; a retry still files the project. */
export const markReplyRecorded = async (ctx: DbCtx, userId: string, replyKey: string, at: number, withoutProject = false): Promise<void> => {
    await ctx.db.insert("usageReplies", { recordedAt: at, replyKey, userId, ...(withoutProject && { withoutProject: true }) });
};

/** Where a reply in `thread` is filed besides the total: its project. */
const attributionOf = (thread: { projectId?: string | null } | null): Attribution => (thread?.projectId ? { projectKey: thread.projectId } : {});

/** Sub-agent threads started from sub-agent threads followed up to a lead with a project, at most. */
const LEAD_HOPS = 4;

/**
 * What replies in `threadId` are filed under: its project, or — for a sub-agent's or worker's thread, which is in no
 * project — its lead thread's, followed through nested runs. A run whose link has been pruned (`subAgentRuns`
 * retention) has no lead to follow, and counts under no project.
 */
const threadProject = async (ctx: ReadCtx, threadId: string): Promise<Attribution> => {
    let current: { projectId?: string | null } | null = await ctx.db.threads.findFirst({ where: { _id: threadId as Id<"threads"> } });
    let currentId = threadId;

    for (let hop = 0; hop < LEAD_HOPS && current && !current.projectId; hop += 1) {
        const lead = await leadThreadOf(ctx, currentId);

        if (lead === undefined) {
            break;
        }

        currentId = lead;
        current = await ctx.db.threads.findFirst({ where: { _id: lead as Id<"threads"> } });
    }

    return attributionOf(current);
};

/**
 * `attribution` as `userId` may file it: without a project they cannot open (a confirmed lack of access — a teammate's
 * personal project, or an organization they have left). A read that fails throws: the record is retried (`RECORD_RETRY`)
 * or the side question refused before it is charged, never filed as if the user had no access.
 */
const readableAttribution = async (ctx: MutationCtx | QueryCtx, attribution: Attribution, userId: string): Promise<Attribution> => {
    if (attribution.projectKey === undefined) {
        return attribution;
    }

    return (await readableProject(ctx, attribution.projectKey as Id<"projects">, userId)) ? attribution : {};
};

/** What `userId`'s reply in `threadId` is filed under: the thread's (or its lead's) project, when they can open it. */
const attributionFor = async (ctx: MutationCtx | QueryCtx, threadId: string | undefined, userId: string): Promise<Attribution> =>
    threadId === undefined || threadId.length === 0 ? {} : await readableAttribution(ctx, await threadProject(ctx, threadId), userId);

const vAttribution = v.object({ projectKey: v.optional(v.string()) });

/**
 * The project a reply in `threadId` is filed under, read where the caller can read the thread: an
 * action off the thread's shard (a side question) reads it here and hands it on with the record.
 */
export const getThreadAttribution = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(vAttribution)
    .query(async ({ args: { threadId, userId }, ctx }) => await attributionFor(ctx, threadId, userId));

/** Adds `increments` to the user's per-day project rows. */
const addToAttributionRollup = async (ctx: DbCtx, userId: string, increments: ReadonlyArray<AttributionIncrement>, at: number): Promise<void> => {
    for (const { costMicrodollars, date, projectKey, replies, skillKey, tokens } of attributionRows(increments)) {
        const existing = await ctx.db.usageDaily.findFirst({ where: { date, projectKey, skillKey, userId } });

        if (existing) {
            await ctx.db.patch("usageDaily", existing._id, {
                costMicrodollars: existing.costMicrodollars + costMicrodollars,
                replies: existing.replies + replies,
                tokens: existing.tokens + tokens,
                updatedAt: at,
            });
        } else {
            await ctx.db.insert("usageDaily", { costMicrodollars, date, projectKey, replies, skillKey, tokens, updatedAt: at, userId });
        }
    }
};

/**
 * Adds `increments` (and their day totals) to the user's rows. `renames` lets an
 * increment's `skillName` replace an existing row's — the live path does, so a
 * renamed skill reads by its current name; the backfill's names are older than
 * whatever a row already holds and only label rows it creates.
 */
export const addToRollup = async (ctx: DbCtx, userId: string, increments: ReadonlyArray<RollupIncrement>, at: number, renames: boolean): Promise<void> => {
    for (const increment of withDayTotals(increments)) {
        const { costMicrodollars, date, replies, skillKey, skillName, tokens } = increment;
        const existing = await ctx.db.usageDaily.findFirst({ where: { date, skillKey, userId } });

        if (existing) {
            await ctx.db.patch("usageDaily", existing._id, {
                costMicrodollars: existing.costMicrodollars + costMicrodollars,
                replies: existing.replies + replies,
                tokens: existing.tokens + tokens,
                updatedAt: at,
                ...(renames && skillName !== undefined && { skillName }),
            });
        } else {
            await ctx.db.insert("usageDaily", {
                costMicrodollars,
                date,
                replies,
                skillKey,
                tokens,
                updatedAt: at,
                userId,
                ...(skillName !== undefined && { skillName }),
            });
        }
    }
};

/**
 * One finished reply: adds to the day's total row and to the day's row for the
 * skill that answered, once per `replyKey`. `at` is the caller's clock, so the
 * handler stays deterministic.
 */
export const recordReplyUsage = internalMutation
    .input({
        at: v.number(),
        costMicrodollars: v.number(),
        date: v.string(),
        /** The project could not be read where the record was sent from: count the total now, and file no project. */
        projectUnread: v.optional(v.boolean()),
        replyKey: v.string(),
        /** A record sent by a retry: with the reply's key missing it counts the reply only while the reply is recent. */
        retry: v.optional(v.boolean()),
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        // Worked out where the thread is readable when the reply ran in another user's thread (`forwardReplyUsage`).
        threadAttribution: v.optional(vAttribution),
        threadId: v.optional(v.string()),
        tokens: v.number(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        if (!isDayKey(args.date) || RESERVED_SKILL_KEYS.has(args.skillKey) || args.replyKey.length === 0) {
            return null;
        }

        // A row written behind the deletion workflow's step would survive the erasure.
        if (await isAccountDeletionUnderway(ctx, args.userId)) {
            return null;
        }

        const costMicrodollars = Math.max(0, Math.round(args.costMicrodollars));
        const tokens = Math.max(0, Math.round(args.tokens));

        // A project read by the caller is checked again here: access revoked since that read files none.
        const attributionNow = async (): Promise<Attribution> =>
            args.threadAttribution === undefined
                ? await attributionFor(ctx, args.threadId, args.userId)
                : await readableAttribution(ctx, args.threadAttribution, args.userId);
        const fileProject = async (attribution: Attribution): Promise<void> => {
            if (attribution.projectKey !== undefined) {
                await addToAttributionRollup(
                    ctx,
                    args.userId,
                    [{ costMicrodollars, date: args.date, projectKey: attribution.projectKey, replies: 1, tokens }],
                    args.at,
                );
            }
        };
        const recorded = await ctx.db.usageReplies.findFirst({ where: { replyKey: args.replyKey, userId: args.userId } });

        // A redelivered job, or a reply the totals backfill already counted: counted once. A reply the backfill counted
        // stays under "No project" (project usage starts at deploy, `usage/AGENTS.md`). One counted without its project
        // (its read failed) is filed here once its project reads: a failed read throws, and the scheduler retries this.
        if (recorded) {
            if (recorded.withoutProject === true && args.projectUnread !== true) {
                await fileProject(await attributionNow());
                await ctx.db.patch("usageReplies", recorded._id, { withoutProject: false });
            }

            return null;
        }

        // A retry's record whose reply is no longer known: a recent reply's record simply has not landed yet, so this one
        // counts it; an old one's key was pruned after its total was counted, so this adds nothing (`RETRY_COUNTS_WITHIN_MS`).
        if (args.retry === true && ctx.now - args.at > RETRY_COUNTS_WITHIN_MS) {
            return null;
        }

        // The total and skill rows land now, whatever the project read does: a read that fails counts the reply without
        // its project and tries the project again on its own (`RECORD_RETRY`).
        let attribution: Attribution = {};
        let projectUnread = args.projectUnread === true;

        if (!projectUnread) {
            try {
                attribution = await attributionNow();
            } catch (error) {
                usageLogger.warn("[usage] the reply's project could not be read; counting it now and trying the project again", {
                    error,
                    replyKey: args.replyKey,
                    threadId: args.threadId,
                    userId: args.userId,
                });
                projectUnread = true;
                await runAfterWithRetry(ctx.scheduler, RECORD_RETRY.baseMs, internal.usage.activity.recordReplyUsage, { ...args, retry: true }, RECORD_RETRY);
            }
        }

        await markReplyRecorded(ctx, args.userId, args.replyKey, args.at, projectUnread);
        await addToRollup(
            ctx,
            args.userId,
            [
                {
                    costMicrodollars,
                    date: args.date,
                    replies: 1,
                    skillKey: args.skillKey,
                    tokens,
                    ...(args.skillName !== undefined && { skillName: args.skillName }),
                },
            ],
            args.at,
            true,
        );

        await fileProject(attribution);

        return null;
    });

/**
 * A reply that ran in another user's thread (shared with the replier) is recorded on the replier's own shard, where the
 * thread is not stored. This runs first on the thread's shard, works out the thread's project, and forwards the
 * record to the replier's shard with it.
 */
export const forwardReplyUsage = internalMutation
    .input({
        at: v.number(),
        costMicrodollars: v.number(),
        date: v.string(),
        /** A retry for the project alone: the reply's total has been sent already. */
        projectRetry: v.optional(v.boolean()),
        replyKey: v.string(),
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        threadId: v.string(),
        tokens: v.number(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { projectRetry, ...usage } = args;
        let threadAttribution: Attribution;

        try {
            threadAttribution = await attributionFor(ctx, usage.threadId, usage.userId);
        } catch (error) {
            // A retry that fails again throws, and the scheduler runs it again (`RECORD_RETRY`).
            if (projectRetry === true) {
                throw error;
            }

            // The total and skill rows go now, without the project; the project is tried again from here.
            usageLogger.warn("[usage] the thread's project could not be read; forwarding the reply's total and trying the project again", {
                error,
                replyKey: usage.replyKey,
                threadId: usage.threadId,
                userId: usage.userId,
            });
            await runAfterOnShard(ctx.scheduler as never, 0, internal.usage.activity.recordReplyUsage, { ...usage, projectUnread: true }, usage.userId);
            await runAfterWithRetry(
                ctx.scheduler,
                RECORD_RETRY.baseMs,
                internal.usage.activity.forwardReplyUsage,
                { ...usage, projectRetry: true },
                RECORD_RETRY,
            );

            return null;
        }

        // A retry's record is a full one: nothing orders it after the total record the first try sent, and the reply's
        // key keeps whichever lands second from counting the total again. Marked as a retry, it counts nothing for a reply
        // old enough that its key may have been pruned.
        const record: ReplyUsageArgs & { retry?: boolean; threadAttribution: Attribution } = {
            ...usage,
            threadAttribution,
            ...(projectRetry === true && { retry: true }),
        };

        // A retry's record may find the reply counted without its project and re-check access: a read that fails there
        // throws, so it runs under the same retry policy as the local path's retry.
        await runAfterOnShard(
            ctx.scheduler as never,
            0,
            internal.usage.activity.recordReplyUsage,
            { ...record },
            usage.userId,
            projectRetry === true ? RECORD_RETRY : undefined,
        );

        return null;
    });

/**
 * The heatmap: one entry per active day in the 53 weeks ending `toDate` (the
 * viewer's today), plus the first day the rollup has for the user.
 */
export const getActivityHeatmap = authQuery
    .input({ toDate: vDayKey() })
    .output(
        v.object({
            days: v.array(v.object({ costMicrodollars: v.number(), date: v.string(), replies: v.number(), tokens: v.number() })),
            trackingSince: v.optional(v.string()),
        }),
    )
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const fromDate = addDays(args.toDate, -(HEATMAP_DAYS - 1));
        const [recent, first] = await Promise.all([
            ctx.db.usageDaily.findMany({
                limit: HEATMAP_DAYS + 7,
                orderBy: [{ date: "desc" }],
                where: { date: { gte: fromDate, lte: args.toDate }, skillKey: TOTAL_SKILL_KEY, userId },
            }),
            ctx.db.usageDaily.findFirst({ orderBy: [{ date: "asc" }], where: { skillKey: TOTAL_SKILL_KEY, userId } }),
        ]);

        return {
            days: foldDayTotals(recent.page),
            ...(first && { trackingSince: first.date }),
        };
    });

/**
 * Replies, tokens and cost per skill from `fromDate` on. `truncated` is set when
 * the window held more rows than one read takes — the oldest days are the ones
 * left out.
 */
export const getSkillBreakdown = authQuery
    .input({ fromDate: vDayKey() })
    .output(
        v.object({
            skills: v.array(
                v.object({
                    costMicrodollars: v.number(),
                    replies: v.number(),
                    skillKey: v.string(),
                    skillName: v.optional(v.string()),
                    tokens: v.number(),
                }),
            ),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const rows = await ctx.db.usageDaily.findMany({
            limit: BREAKDOWN_ROW_LIMIT,
            orderBy: [{ date: "desc" }],
            // Project rows are another breakdown's; they must not use up this read's bound.
            where: { date: { gte: args.fromDate }, skillKey: { ne: PROJECT_SKILL_KEY }, userId },
        });

        return {
            skills: foldSkillTotals(rows.page),
            truncated: rows.page.length >= BREAKDOWN_ROW_LIMIT,
        };
    });
