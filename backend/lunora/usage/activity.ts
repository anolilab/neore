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
 * leaves its earlier usage where it was. The project breakdown and a project's
 * totals read those rows ({@link getProjectBreakdown}, {@link getProjectUsage}).
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authQuery } from "../lib/crpc";
import { projectOrganizationOf, readableProject } from "../projects/functions";
import type { Attribution, AttributionIncrement, ProjectTotal, RollupIncrement } from "./activity-logic";
import {
    addDays,
    BREAKDOWN_ROW_LIMIT,
    foldDayTotals,
    foldProjectTotals,
    foldSkillTotals,
    HEATMAP_DAYS,
    isDayKey,
    attributionRows,
    ORGANIZATION_SKILL_KEY,
    PROJECT_ROW_LIMIT,
    organizationFiledKey,
    PROJECT_SKILL_KEY,
    projectFiledKey,
    remainderOf,
    sumRows,
    TOTAL_SKILL_KEY,
    usageDayOf,
    withDayTotals,
} from "./activity-logic";

/** A `YYYY-MM-DD` argument, refused at the boundary when it is anything else. */
const vDayKey = () => v.string().check(isDayKey, { message: "Expected a YYYY-MM-DD date", schema: { maxLength: 10, minLength: 10 } });

/** `skillKey`s the rollup keeps for itself; a reply never records under one. */
const RESERVED_SKILL_KEYS = new Set([ORGANIZATION_SKILL_KEY, PROJECT_SKILL_KEY, TOTAL_SKILL_KEY]);

type DbCtx = Pick<MutationCtx, "db">;

/** Whether the reply keyed `replyKey` is already in the user's rollup. */
export const isReplyRecorded = async (ctx: DbCtx, userId: string, replyKey: string): Promise<boolean> =>
    (await ctx.db.usageReplies.findFirst({ where: { replyKey, userId } })) !== null;

/** `projectFiled`: the reply's project was filed with it, so the project walk leaves it alone. */
export const markReplyRecorded = async (ctx: DbCtx, userId: string, replyKey: string, at: number, projectFiled = false): Promise<void> => {
    await ctx.db.insert("usageReplies", { recordedAt: at, replyKey, userId, ...(projectFiled && { projectFiled: true }) });
};

/** Where a reply in `thread` is filed besides the total: its project, and the organization of that project or else of the thread. */
export const attributionOf = async (ctx: DbCtx, thread: { organizationId?: string | null; projectId?: string | null } | null): Promise<Attribution> => {
    if (!thread) {
        return {};
    }

    const projectKey = thread.projectId ?? undefined;
    const projectOrganization = projectKey === undefined ? undefined : await projectOrganizationOf(ctx, projectKey);
    const organizationId = projectOrganization ?? thread.organizationId ?? undefined;

    return {
        ...(projectKey !== undefined && { projectKey }),
        ...(organizationId !== undefined && { organizationId }),
        ...(projectOrganization !== undefined && { projectInOrganization: true }),
    };
};

/** The attribution of the user's thread `threadId`, when it is on this shard. */
const attributionOfThread = async (ctx: DbCtx, threadId: string | undefined): Promise<Attribution> => {
    if (threadId === undefined || threadId.length === 0) {
        return {};
    }

    return await attributionOf(ctx, await ctx.db.threads.findFirst({ where: { _id: threadId as Id<"threads"> } }));
};

/**
 * Files a recorded reply under its project and organization, each part once: the project walk may have filed the
 * project row already (it marks `project:<key>`), but it never files an organization row, which is marked on its own.
 */
const fileAttribution = async (
    ctx: DbCtx,
    reply: { at: number; replyKey: string; userId: string },
    attribution: Attribution,
    date: string,
    amounts: { costMicrodollars: number; tokens: number },
): Promise<void> => {
    const { at, replyKey, userId } = reply;
    const fileProject = attribution.projectKey !== undefined && !(await isReplyRecorded(ctx, userId, projectFiledKey(replyKey)));
    const fileOrganization = attribution.organizationId !== undefined && !(await isReplyRecorded(ctx, userId, organizationFiledKey(replyKey)));
    const increments: AttributionIncrement[] = [];

    if (fileProject) {
        increments.push({ ...amounts, date, replies: 1, ...attribution, organizationRow: false });
        await markReplyRecorded(ctx, userId, projectFiledKey(replyKey), at);
    }

    if (fileOrganization) {
        increments.push({ ...amounts, date, organizationId: attribution.organizationId, replies: 1 });
        await markReplyRecorded(ctx, userId, organizationFiledKey(replyKey), at);
    }

    await addToAttributionRollup(ctx, userId, increments, at);
};

/** Adds `increments` to the user's per-day project and organization rows. */
export const addToAttributionRollup = async (ctx: DbCtx, userId: string, increments: ReadonlyArray<AttributionIncrement>, at: number): Promise<void> => {
    for (const row of attributionRows(increments)) {
        const { costMicrodollars, date, organizationId, projectKey, replies, skillKey, tokens } = row;
        // The organization is part of a row's key, and an absent one cannot be matched in a query: compare here.
        const { page: candidates } = await ctx.db.usageDaily.findMany({
            limit: 50,
            where: { date, skillKey, userId, ...(projectKey !== undefined && { projectKey }), ...(organizationId !== undefined && { organizationId }) },
        });
        const existing = candidates.find(
            (candidate) => (candidate.organizationId ?? undefined) === organizationId && (candidate.projectKey ?? undefined) === projectKey,
        );

        if (existing) {
            await ctx.db.patch("usageDaily", existing._id, {
                costMicrodollars: existing.costMicrodollars + costMicrodollars,
                replies: existing.replies + replies,
                tokens: existing.tokens + tokens,
                updatedAt: at,
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
                ...(projectKey !== undefined && { projectKey }),
                ...(organizationId !== undefined && { organizationId }),
            });
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

        // A redelivered job (already filed everywhere), or a reply the backfill reached first: the first walk files no
        // project and no walk files an organization, so whatever is still missing is filed here, each part once.
        if (recorded) {
            if (!recorded.projectFiled) {
                await fileAttribution(ctx, args, await attributionOfThread(ctx, args.threadId), await countedDayOf(ctx, args), { costMicrodollars, tokens });
            }

            return null;
        }

        await markReplyRecorded(ctx, args.userId, args.replyKey, args.at, true);
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

        await fileAttribution(ctx, args, await attributionOfThread(ctx, args.threadId), args.date, { costMicrodollars, tokens });

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
            where: { date: { gte: args.fromDate }, skillKey: { notIn: [PROJECT_SKILL_KEY, ORGANIZATION_SKILL_KEY] }, userId },
        });

        return {
            skills: foldSkillTotals(rows.page),
            truncated: rows.page.length >= BREAKDOWN_ROW_LIMIT,
        };
    });

const vTotals = { costMicrodollars: v.number(), replies: v.number(), tokens: v.number() };

/** Project title lookups one breakdown runs at once. */
const TITLE_LOOKUPS_AT_ONCE = 16;

/** Total rows from `fromDate` on, summed: one per day, so a year is a bounded read. */
const totalSince = async (ctx: Pick<QueryCtx, "db">, userId: string, fromDate: string) => {
    const { page } = await ctx.db.usageDaily.findMany({
        limit: HEATMAP_DAYS * 2,
        orderBy: [{ date: "desc" }],
        where: { date: { gte: fromDate }, skillKey: TOTAL_SKILL_KEY, userId },
    });

    return { total: sumRows(page), truncated: page.length >= HEATMAP_DAYS * 2 };
};

/**
 * Replies, tokens and cost per project from `fromDate` on, with what no project
 * accounts for (`noProject`) and the overall `total` — the projects and
 * `noProject` add up to it. A project the caller can no longer read has no
 * `title`. `truncated` as in {@link getSkillBreakdown}.
 */
export const getProjectBreakdown = authQuery
    .input({ fromDate: vDayKey() })
    .output(
        v.object({
            noProject: v.object({ ...vTotals }),
            projects: v.array(v.object({ ...vTotals, projectKey: v.string(), title: v.optional(v.string()) })),
            total: v.object({ ...vTotals }),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const [totals, rows] = await Promise.all([
            totalSince(ctx, userId, args.fromDate),
            ctx.db.usageDaily.findMany({
                limit: PROJECT_ROW_LIMIT,
                orderBy: [{ date: "desc" }],
                where: { date: { gte: args.fromDate }, skillKey: PROJECT_SKILL_KEY, userId },
            }),
        ]);
        const projects = foldProjectTotals(rows.page);
        const titled: (ProjectTotal & { title?: string })[] = [];

        // A few lookups at a time: each is up to three reads, and a long history holds many projects.
        for (let index = 0; index < projects.length; index += TITLE_LOOKUPS_AT_ONCE) {
            const batch = await Promise.all(
                projects.slice(index, index + TITLE_LOOKUPS_AT_ONCE).map(async (project) => {
                    const found = await readableProject(ctx, project.projectKey as Id<"projects">, userId).catch(() => null);

                    return { ...project, ...(found && { title: found.title }) };
                }),
            );

            titled.push(...batch);
        }

        return {
            noProject: remainderOf(totals.total, projects),
            projects: titled,
            total: totals.total,
            truncated: totals.truncated || rows.page.length >= PROJECT_ROW_LIMIT,
        };
    });

/** Project rows one project read sums: a project row per day (and per organization it was filed under) for a year. */
const PROJECT_USAGE_ROW_LIMIT = HEATMAP_DAYS * 2;

/**
 * The caller's replies, tokens and cost in one project from `fromDate` on. `truncated` is set when the period held more
 * rows than one read sums — the oldest days are the ones left out.
 */
export const getProjectUsage = authQuery
    .input({ fromDate: vDayKey(), projectId: v.id("projects") })
    .output(v.object({ ...vTotals, truncated: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const { page } = await ctx.db.usageDaily.findMany({
            limit: PROJECT_USAGE_ROW_LIMIT + 1,
            orderBy: [{ date: "desc" }],
            where: { date: { gte: args.fromDate }, projectKey: args.projectId as string, userId: ctx.user.userId },
        });

        return { ...sumRows(page.slice(0, PROJECT_USAGE_ROW_LIMIT)), truncated: page.length > PROJECT_USAGE_ROW_LIMIT };
    });
