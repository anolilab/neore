/**
 * The three steps a submit takes on the draft row, as internal mutations the
 * submit action calls (`submit-review.ts` fixes their order): claim, then finish
 * once the host confirmed the review, or release when it did not.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { isSubmitting, withoutSent } from "./draft-logic";
import { draftFor } from "./review-drafts";
import { vDraftComment, vReviewVerdict } from "./validators";

const address = { number: v.number(), repository: v.string().max(MAX_LENGTH.short), userId: v.string().max(MAX_LENGTH.id) };

/** Takes the draft for one submit. A claim whose lease ran out is taken over: its submitter died. */
export const claimDraftForSubmit = internalMutation
    .input(address)
    .output(
        v.union(
            v.object({
                draft: v.object({
                    body: v.string(),
                    comments: v.array(vDraftComment),
                    commitId: v.string(),
                    revision: v.number(),
                    verdict: v.union(vReviewVerdict, v.null()),
                }),
                status: v.literal("claimed"),
            }),
            v.object({ status: v.union(v.literal("in_progress"), v.literal("no_draft")) }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const draft = await draftFor(ctx, args.userId, args.repository, args.number);

        if (draft === null) {
            return { status: "no_draft" as const };
        }

        const { now } = ctx;

        if (isSubmitting(draft, now)) {
            return { status: "in_progress" as const };
        }

        await ctx.db.patch(draft._id, { submittingAt: now });

        return {
            draft: { body: draft.body, comments: draft.comments, commitId: draft.commitId, revision: draft.revision, verdict: draft.verdict },
            status: "claimed" as const,
        };
    });

/**
 * The host confirmed the review. A draft nobody touched since the claim goes; one that
 * was edited anyway (a lease that ran out) keeps only the comments the host did not receive.
 */
export const finishDraftSubmit = internalMutation
    .input({ ...address, revision: v.number(), sentIds: v.array(v.string().max(MAX_LENGTH.id)) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const draft = await draftFor(ctx, args.userId, args.repository, args.number);

        if (draft === null) {
            return null;
        }

        if (draft.revision === args.revision) {
            await ctx.db.delete(draft._id);

            return null;
        }

        // The summary and verdict went out with the review too.
        await ctx.db.patch(draft._id, { body: "", comments: withoutSent(draft.comments, args.sentIds), submittingAt: 0, verdict: null });

        return null;
    });

/** The host did not take the review: the draft stays exactly as it was and can be submitted again. */
export const releaseDraftSubmit = internalMutation
    .input(address)
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const draft = await draftFor(ctx, args.userId, args.repository, args.number);

        if (draft !== null) {
            await ctx.db.patch(draft._id, { submittingAt: 0 });
        }

        return null;
    });
