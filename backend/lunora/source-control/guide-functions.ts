/**
 * Develop mode, guides: ask for the AI guide of a pull request, read it, and act on what it proposes.
 *
 * - `generateGuide` is an ACTION that reads the pull request's head from the host, reserves the row, charges the
 *   daily text quota like other utility work and puts the generation on the jobs queue (`guide-job.ts`).
 * - `getGuide` is a live query: the page sees the guide fill in, and whether the pull request has moved past it.
 * - A proposal is a SUGGESTION. `applyGuideProposal` writes a comment into the user's review DRAFT through the same
 *   path as the Files tab, and nothing reaches the host until the user submits that review.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { chargeDailyLimit } from "../chat/lib/daily-limit";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { enqueueJob } from "../lib/job-queue";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { effectiveStatus, pickGuide } from "./guide-logic";
import { guidesFor } from "./guide-internal";
import { readFromHost } from "./read-host";
import { saveDraftCommentFor } from "./review-drafts";
import { vFailed, vGuideFailure, vGuideProposal, vGuideSource, vGuideStatus, vGuideStop } from "./validators";

const vRef = { number: v.number(), repository: v.string().max(MAX_LENGTH.short) };

const vGuideView = v.object({
    failure: v.optional(vGuideFailure),
    generatedAt: v.number(),
    headSha: v.string(),
    id: v.string(),
    instructions: v.string(),
    leftOut: v.number(),
    proposals: v.array(vGuideProposal),
    source: vGuideSource,
    status: vGuideStatus,
    stops: v.array(vGuideStop),
    summary: v.string(),
    threadId: v.optional(v.string()),
});

/** The guide for a pull request as its page shows it: the newest for the head the page has, or an earlier one marked stale. */
export const getGuide = authQuery
    .input({ ...vRef, headSha: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.null(), v.object({ freshness: v.union(v.literal("current"), v.literal("stale")), guide: vGuideView })))
    .query(async ({ args, ctx }) => {
        const found = pickGuide(await guidesFor(ctx, ctx.user.userId, args.repository, args.number), args.headSha);

        if (!found) {
            return null;
        }

        const { guide } = found;
        const status = effectiveStatus(guide, ctx.now);

        return {
            freshness: found.freshness,
            guide: {
                generatedAt: guide.generatedAt,
                headSha: guide.headSha,
                id: guide._id as string,
                instructions: guide.instructions,
                leftOut: guide.leftOut,
                proposals: guide.proposals,
                source: guide.source,
                status,
                stops: guide.stops,
                summary: guide.summary,
                ...(status === "failed" && { failure: guide.failure ?? ("abandoned" as const) }),
                ...(guide.threadId !== undefined && { threadId: guide.threadId }),
            },
        };
    });

/**
 * Starts a cloud guide for the pull request's CURRENT head (read from the host here, never taken from the page).
 * `running`: a guide for this pull request is already being written. `quota`: the daily text quota is spent.
 */
export const generateGuide = authAction
    .use(rateLimit("sourceControl/guide"))
    .input({ ...vRef, instructions: v.string().max(MAX_LENGTH.long) })
    .output(
        v.union(
            v.object({ status: v.literal("started") }),
            v.object({ status: v.union(v.literal("guest"), v.literal("running")) }),
            v.object({ retryAfter: v.optional(v.number()), status: v.literal("quota") }),
            vFailed,
        ),
    )
    .action(async ({ args, ctx }) => {
        const { plan, role, userId } = ctx.user;
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            return { status: "guest" as const };
        }

        const token = await resolveGithubToken(ctx, userId);
        const head = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const detail = await DEVELOP_DRIVER.getPullRequest(request, args);

            return { headSha: detail.headSha };
        });

        if (head.status !== "ok") {
            return { status: head.status };
        }

        const jobId = crypto.randomUUID();
        const begun = await ctx.runMutation(internal.source_control.guide_internal.beginGuide, {
            headSha: head.headSha,
            instructions: args.instructions.trim(),
            jobId,
            number: args.number,
            repository: args.repository,
            source: "cloud",
            userId,
        });

        if (begun.status === "running") {
            return { status: "running" as const };
        }

        // The model call is paid for: one unit of the daily text quota, like a translation. Charged after the row is reserved,
        // so a double click is not charged twice, and the row is failed again when the quota refuses.
        const charge = await chargeDailyLimit(ctx, { _id: userId, isAnonymous: false, plan: plan ?? null, role: role ?? null }, "Text");

        if (!charge.ok) {
            await ctx.runMutation(internal.source_control.guide_internal.failGuide, { failure: "quota", guideId: begun.guideId, userId });

            return { status: "quota" as const, ...(charge.retryAfter !== undefined && { retryAfter: charge.retryAfter }) };
        }

        await enqueueJob(
            internal.source_control.guide_job.runCloudGuide,
            { guideId: begun.guideId, userId },
            {
                once: {
                    jobId,
                    onLapse: { args: { guideId: begun.guideId, userId }, ref: internal.source_control.guide_internal.failAbandonedGuide },
                    userId,
                },
                shardKey: userId,
            },
        );

        ctx.log.event("source_control.guide_requested", { source: "cloud" });

        return { status: "started" as const };
    });

const vApplied = v.union(
    v.object({ commentId: v.union(v.string(), v.null()), status: v.literal("applied") }),
    v.object({ status: v.union(v.literal("head_moved"), v.literal("not_found"), v.literal("not_ready"), v.literal("submitting"), v.literal("too_many")) }),
);

/**
 * Puts a proposed comment into the user's review draft. This is the ONLY thing applying does: the host hears nothing
 * until the user submits the review. A proposal applies once, and only a comment (a label has no write to apply).
 */
export const applyGuideProposal = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({ guideId: v.id("pullRequestGuides"), proposalId: v.string().max(MAX_LENGTH.id) })
    .output(vApplied)
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId } });
        const proposal = guide?.proposals.find((candidate) => candidate.id === args.proposalId);

        if (!guide || proposal?.kind !== "comment") {
            return { status: "not_found" as const };
        }

        if (guide.status !== "ready" || proposal.status !== "proposed") {
            return { status: "not_ready" as const };
        }

        const saved = await saveDraftCommentFor(ctx, userId, {
            body: proposal.body,
            // The comment's lines are the guide's head: a draft built on another head refuses it (`head_moved`).
            commitId: guide.headSha,
            line: proposal.line,
            number: guide.number,
            path: proposal.path,
            repository: guide.repository,
            side: proposal.side,
            startLine: proposal.startLine,
        });

        if (saved.status !== "ok") {
            return { status: saved.status === "not_found" ? ("not_found" as const) : saved.status };
        }

        await ctx.db.patch(guide._id, {
            proposals: guide.proposals.map((candidate) => (candidate.id === proposal.id ? { ...candidate, status: "applied" as const } : candidate)),
            updatedAt: ctx.now,
        });

        ctx.log.event("source_control.guide_proposal_applied", { kind: "comment" });

        return { commentId: saved.commentId, status: "applied" as const };
    });

export const dismissGuideProposal = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({ guideId: v.id("pullRequestGuides"), proposalId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ status: v.union(v.literal("dismissed"), v.literal("not_found")) }))
    .mutation(async ({ args, ctx }) => {
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId: ctx.user.userId } });
        const proposal = guide?.proposals.find((candidate) => candidate.id === args.proposalId);

        if (!guide || !proposal || proposal.status !== "proposed") {
            return { status: "not_found" as const };
        }

        await ctx.db.patch(guide._id, {
            proposals: guide.proposals.map((candidate) => (candidate.id === proposal.id ? { ...candidate, status: "dismissed" as const } : candidate)),
            updatedAt: ctx.now,
        });

        return { status: "dismissed" as const };
    });
