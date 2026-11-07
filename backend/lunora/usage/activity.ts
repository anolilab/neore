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
import { runAfterOnShard } from "../lib/shard-scheduler";
import { readableProject } from "../projects/functions";
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
    projectFiledKey,
    TOTAL_SKILL_KEY,
    usageDayOf,
    withDayTotals,
} from "./activity-logic";

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

/** What the first walk added to the total for a reply. */
export interface CountedReply {
    costMicrodollars: number;
    date: string;
    tokens: number;
}

/**
 * `projectFiled`: the reply's project was filed with it, so the project walk leaves it alone. `counted`: what the first
 * walk added to the total, the amount any project row filed for the reply later must carry.
 */
export const markReplyRecorded = async (
    ctx: DbCtx,
    userId: string,
    replyKey: string,
    at: number,
    extra: { counted?: CountedReply; projectFiled?: boolean } = {},
): Promise<void> => {
    await ctx.db.insert("usageReplies", {
        recordedAt: at,
        replyKey,
        userId,
        ...(extra.counted !== undefined && { counted: extra.counted }),
        ...(extra.projectFiled === true && { projectFiled: true }),
    });
};

/** Where a reply in `thread` is filed besides the total: its project. */
export const attributionOf = (thread: { projectId?: string | null } | null): Attribution => (thread?.projectId ? { projectKey: thread.projectId } : {});

/** The attribution of the user's thread `threadId`, when it is on this shard. */
const attributionOfThread = async (ctx: ReadCtx, threadId: string | undefined): Promise<Attribution> => {
    if (threadId === undefined || threadId.length === 0) {
        return {};
    }

    return attributionOf(await ctx.db.threads.findFirst({ where: { _id: threadId as Id<"threads"> } }));
};

/**
 * What `userId`'s reply in a thread they may not own is filed under: the thread's attribution, without a project the
 * replier cannot open — a teammate's personal project shared through one thread is not theirs to see in their usage.
 */
const attributionForReplier = async (ctx: MutationCtx | QueryCtx, threadId: string, userId: string): Promise<Attribution> => {
    const attribution = await attributionOfThread(ctx, threadId);

    if (attribution.projectKey === undefined || (await readableProject(ctx, attribution.projectKey as Id<"projects">, userId).catch(() => null))) {
        return attribution;
    }

    return {};
};

const vAttribution = v.object({ projectKey: v.optional(v.string()) });

/**
 * The project a reply in `threadId` is filed under, read where the caller can read the thread: an
 * action off the thread's shard (a side question) reads it here and hands it on with the record.
 */
export const getThreadAttribution = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(vAttribution)
    .query(async ({ args: { threadId, userId }, ctx }) => await attributionForReplier(ctx, threadId, userId));

/**
 * Files a recorded reply under its project, once: the project walk may have filed it already (it marks
 * `project:<key>`). A first record needs no marker — the reply's own key (`projectFiled`) stops the walk and any
 * redelivery. A late record (`finalize`) marks it whatever it filed, so a later delivery, after the thread has moved,
 * cannot file the reply again under another project.
 */
const fileAttribution = async (
    ctx: DbCtx,
    reply: { at: number; replyKey: string; userId: string },
    attribution: Attribution,
    date: string,
    amounts: { costMicrodollars: number; tokens: number },
    finalize: boolean,
): Promise<void> => {
    const { at, replyKey, userId } = reply;
    const projectFiled = await isReplyRecorded(ctx, userId, projectFiledKey(replyKey));

    if (finalize && !projectFiled) {
        await markReplyRecorded(ctx, userId, projectFiledKey(replyKey), at);
    }

    if (attribution.projectKey !== undefined && !projectFiled) {
        await addToAttributionRollup(ctx, userId, [{ ...amounts, date, projectKey: attribution.projectKey, replies: 1 }], at);
    }
};

/** Adds `increments` to the user's per-day project rows. */
export const addToAttributionRollup = async (ctx: DbCtx, userId: string, increments: ReadonlyArray<AttributionIncrement>, at: number): Promise<void> => {
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
 * The day an already-counted reply's total sits on. The first walk dates a reply by its first row, in the zone it
 * snapshotted when it started; a reply that ran past midnight would otherwise put its project row on the next day.
 */
const countedDayOf = async (ctx: DbCtx, args: { date: string; startedAt?: number; userId: string }): Promise<string> => {
    if (args.startedAt === undefined) {
        return args.date;
    }

    const state = await ctx.db.usageBackfill.findFirst({ where: { userId: args.userId } });
    const settings = state?.timeZone ? null : await ctx.db.userSettings.findFirst({ where: { userId: args.userId } });
    const timeZone = state?.timeZone ?? settings?.timezone;

    return usageDayOf(args.startedAt, timeZone);
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
        replyKey: v.string(),
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        startedAt: v.optional(v.number()),
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
        const recorded = await ctx.db.usageReplies.findFirst({ where: { replyKey: args.replyKey, userId: args.userId } });

        // A redelivered job (already filed), or a reply the backfill reached first: the first walk files no project, so
        // the project is filed here, once.
        if (recorded) {
            if (!recorded.projectFiled) {
                // The project gets what the total holds for the reply: the first walk's count when it made one (a run it
                // passed while paused holds less than this record says), else this record dated as the walk would.
                const { counted } = recorded;

                await fileAttribution(
                    ctx,
                    args,
                    args.threadAttribution ?? (await attributionOfThread(ctx, args.threadId)),
                    counted?.date ?? (await countedDayOf(ctx, args)),
                    counted ? { costMicrodollars: counted.costMicrodollars, tokens: counted.tokens } : { costMicrodollars, tokens },
                    true,
                );
            }

            return null;
        }

        await markReplyRecorded(ctx, args.userId, args.replyKey, args.at, { projectFiled: true });
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

        await fileAttribution(
            ctx,
            args,
            args.threadAttribution ?? (await attributionOfThread(ctx, args.threadId)),
            args.date,
            { costMicrodollars, tokens },
            false,
        );

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
        replyKey: v.string(),
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        startedAt: v.optional(v.number()),
        threadId: v.string(),
        tokens: v.number(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const threadAttribution = await attributionForReplier(ctx, args.threadId, args.userId);
        const record: ReplyUsageArgs & { threadAttribution: Attribution } = { ...args, threadAttribution };

        await runAfterOnShard(ctx.scheduler as never, 0, internal.usage.activity.recordReplyUsage, { ...record }, args.userId);

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
