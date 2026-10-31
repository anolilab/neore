/**
 * The guide row's lifecycle, as internal mutations: reserve it, fill it, fail it. Only the generation job and the host
 * turn's finalizer call these; a client reaches a guide through `guide-functions.ts`, which can only read it and change
 * a proposal's status.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { GUIDES_KEPT_PER_PULL, isRunning } from "./guide-logic";
import { vGuideFailure, vGuideProposal, vGuideSource, vGuideStop } from "./validators";

const address = { number: v.number(), repository: v.string().max(MAX_LENGTH.short), userId: v.string().max(MAX_LENGTH.id) };

/** The user's stored guides for one pull request, newest first. At most a handful: older ones are pruned. */
export const guidesFor = async (ctx: Pick<QueryCtx, "db">, userId: string, repo: string, number: number): Promise<Doc<"pullRequestGuides">[]> => {
    const rows = await ctx.db
        .query("pullRequestGuides")
        .withIndex("by_user_and_pull", (q) => q.eq("userId", userId).eq("hostOrigin", DEVELOP_DRIVER.webOrigin).eq("repository", repo).eq("number", number))
        .take(GUIDES_KEPT_PER_PULL + 5);

    return rows.toSorted((a, b) => b.createdAt - a.createdAt);
};

export interface ReserveGuideInput {
    headSha: string;
    instructions: string;
    jobId?: string;
    number: number;
    repository: string;
    source: "cloud" | "host";
    userId: string;
}

/**
 * Reserves a guide: one row in `generating`, unless a run for this pull request is already going (one at a time per
 * pull request, so a double click or a second device does not pay twice). Keeps the newest few guides of the pull request.
 */
export const reserveGuide = async (
    ctx: MutationCtx,
    row: ReserveGuideInput,
): Promise<{ guideId: Id<"pullRequestGuides">; status: "started" } | { status: "running" }> => {
    const { now } = ctx;
    const existing = await guidesFor(ctx, row.userId, row.repository, row.number);

    if (existing.some((guide) => isRunning(guide, now))) {
        return { status: "running" as const };
    }

    const guideId = await ctx.db.insert("pullRequestGuides", {
        createdAt: now,
        generatedAt: 0,
        headSha: row.headSha,
        hostOrigin: DEVELOP_DRIVER.webOrigin,
        instructions: row.instructions,
        leftOut: 0,
        number: row.number,
        proposals: [],
        repository: row.repository,
        source: row.source,
        status: "generating",
        stops: [],
        summary: "",
        updatedAt: now,
        userId: row.userId,
        ...(row.jobId !== undefined && { jobId: row.jobId }),
    });

    // The newest GUIDES_KEPT_PER_PULL stay; this one is among them.
    await Promise.all(existing.slice(GUIDES_KEPT_PER_PULL - 1).map((guide) => ctx.db.delete(guide._id)));

    return { guideId, status: "started" as const };
};

export const beginGuide = internalMutation
    .input({
        ...address,
        headSha: v.string().max(MAX_LENGTH.short),
        instructions: v.string().max(MAX_LENGTH.long),
        jobId: v.optional(v.string().max(MAX_LENGTH.id)),
        source: vGuideSource,
    })
    .output(v.union(v.object({ guideId: v.id("pullRequestGuides"), status: v.literal("started") }), v.object({ status: v.literal("running") })))
    .mutation(async ({ args, ctx }) => await reserveGuide(ctx, args));

/** The inputs the generation job needs from the row. `null` when the guide is gone or no longer generating. */
export const readGuideForJob = internalQuery
    .input({ guideId: v.id("pullRequestGuides"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), v.object({ headSha: v.string(), instructions: v.string(), number: v.number(), repository: v.string() })))
    .query(async ({ args, ctx }) => {
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId: args.userId } });

        if (!guide || guide.status !== "generating") {
            return null;
        }

        return { headSha: guide.headSha, instructions: guide.instructions, number: guide.number, repository: guide.repository };
    });

/** Fills the row. Only a row still running takes it: a redelivered job, or an answer that arrives after the run's window (the page already reads it as abandoned), writes nothing. */
export const saveGuide = internalMutation
    .input({
        guideId: v.id("pullRequestGuides"),
        headSha: v.string().max(MAX_LENGTH.short),
        leftOut: v.number(),
        proposals: v.array(vGuideProposal),
        stops: v.array(vGuideStop),
        summary: v.string().max(MAX_LENGTH.long),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId: args.userId } });

        if (!guide || !isRunning(guide, ctx.now)) {
            return false;
        }

        await ctx.db.patch(guide._id, {
            generatedAt: ctx.now,
            // The head the guide was actually written from: the host may have moved on since the run began.
            headSha: args.headSha,
            leftOut: args.leftOut,
            proposals: args.proposals,
            status: "ready",
            stops: args.stops,
            summary: args.summary,
            updatedAt: ctx.now,
        });

        return true;
    });

/** Fails a guide that is still `generating`; one that already finished or failed is left as it is. */
export const markGuideFailed = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    userId: string,
    guideId: Id<"pullRequestGuides">,
    failure: Infer<typeof vGuideFailure>,
): Promise<boolean> => {
    const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: guideId, userId } });

    if (!guide || guide.status !== "generating") {
        return false;
    }

    await ctx.db.patch(guide._id, { failure, status: "failed", updatedAt: ctx.now });

    return true;
};

export const failGuide = internalMutation
    .input({ failure: vGuideFailure, guideId: v.id("pullRequestGuides"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await markGuideFailed(ctx, args.userId, args.guideId, args.failure));

/** The `onLapse` of a guide job (`lib/job-once.ts`): its delivery died mid-run, so the row would spin. The paid call is never re-run. */
export const failAbandonedGuide = internalMutation
    .input({ claimKey: v.string().max(MAX_LENGTH.id), guideId: v.id("pullRequestGuides"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId: args.userId } });

        // Only the run this claim belongs to: a newer guide for the same pull request is not touched.
        if (!guide || guide.status !== "generating" || guide.jobId !== args.claimKey) {
            return false;
        }

        await ctx.db.patch(guide._id, { failure: "abandoned", status: "failed", updatedAt: ctx.now });

        return true;
    });
