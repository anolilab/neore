/**
 * Answering a `requestSecret` card (`chat/tools/request-secret.ts`), spending
 * the reference it yields, and sweeping the ones nobody spent.
 *
 * The card is a `tool-approval-request` for the `requestSecret` call, so
 * `answerSecretRequest` is `respondToToolApproval` with a value instead of a
 * decision: the same owner check, the same single `pending -> approved|denied`
 * transition on the run's `toolApprovalRuns` snapshot, the same continuation
 * (`continueAfterToolApproval`, on the jobs queue). Saving encrypts the value
 * (`lib/request-secret-claim.ts`); the continuation, the thread and the tool
 * result carry only the reference. Declining denies the call with a reason.
 *
 * The consumers take a reference from the agent's tool call and write the value
 * to the destination the user approved (`lib/secret-consumers.ts`). They are
 * internal: the tool passes the run's own user and thread, so a reference is
 * spent for the user and thread that asked, and by nobody else.
 *
 * The value is an argument of exactly one client procedure — this one — and is
 * never passed to a log call, an event or a job.
 */
import { MAX_LENGTH } from "../lib/validators";
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { authMutation, rateLimit } from "../lib/crpc";
import { rateLimitGuard } from "../lib/rate-limiter";
import { claimSecretAnswer, secretResumeArgs } from "./lib/request-secret-claim";
import { consumeAsMcpHeader, consumeAsProviderKey } from "./lib/secret-consumers";
import { discardThreadSecrets, sweepExpiredSecrets } from "./lib/secret-requests";
import { resumeClaimedRun } from "./lib/tool-approval-resume";
import { SECRET_HEADER_VALUE_MAX, SECRET_REF_MAX } from "./tools/request-secret-constants";

/** Rows removed per sweep; a backlog drains over the next passes. */
const SWEEP_BATCH = 200;

const vConsumeResult = v.union(
    v.object({ message: v.string(), status: v.string() }),
    v.object({ provider: v.string(), status: v.literal("saved") }),
    v.object({ header: v.string(), server: v.string(), status: v.literal("saved") }),
);

const vConsumeArgs = {
    ref: v.string().max(SECRET_REF_MAX),
    /** Who started the turn that is spending the reference; the owner's own turns only (a continuation runs as the owner whoever started it). */
    startedBy: v.string().max(MAX_LENGTH.id),
    threadId: v.string().max(MAX_LENGTH.id),
    userId: v.string().max(MAX_LENGTH.id),
};

export const answerSecretRequest = authMutation
    .use(rateLimit("chat/stream"))
    .input({
        approvalId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid approval id" }),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        /** `null` declines to provide the secret. The destination's own limit applies on top of this one. */
        value: v.union(
            v.string().check((value) => value.length <= SECRET_HEADER_VALUE_MAX * 2, { message: "Value too long" }),
            v.null(),
        ),
    })
    .output(v.object({ alreadyResolved: v.boolean(), streamId: v.union(v.string(), v.null()) }))
    .mutation(async ({ args: { approvalId, threadId, unlockProof, value }, ctx }) => {
        const claim = await claimSecretAnswer(ctx, {
            approvalId,
            callerId: ctx.user.userId,
            now: ctx.now,
            reply: value === null ? { kind: "decline" } : { kind: "save", value },
            threadId,
            unlockProof,
        });

        if (claim.kind === "already-resolved") {
            return { alreadyResolved: true, streamId: claim.streamId };
        }

        // A provider key counts against the same budget as saving one in Settings. A throw rolls the claim back.
        if (claim.use?.kind === "provider_key") {
            await rateLimitGuard({ ...ctx, rateLimitKey: "byok/save", user: ctx.user });
        }

        const streamId = await resumeClaimedRun(ctx, {
            approvalId,
            config: claim.config,
            ownerId: claim.ownerId,
            runId: claim.runId,
            threadId,
            ...secretResumeArgs(claim),
        });

        // Whether it was saved, never what it was.
        ctx.log.event("chat.answer_secret_request", { alreadyResolved: false, declined: claim.ref === undefined, resumed: true });

        return { alreadyResolved: false, streamId };
    });

/** Spend a reference as the user's own API key for the provider the card named. Called by `saveSecretAsProviderKey`. */
export const consumeSecretAsProviderKey = internalMutation
    .input(vConsumeArgs)
    .output(vConsumeResult)
    .mutation(async ({ args, ctx }) => await consumeAsProviderKey(ctx, { ...args, now: ctx.now }));

/** Spend a reference as a header on the MCP server the card named. Called by `setMcpServerSecret`. */
export const consumeSecretAsMcpHeader = internalMutation
    .input(vConsumeArgs)
    .output(vConsumeResult)
    .mutation(async ({ args, ctx }) => await consumeAsMcpHeader(ctx, { ...args, now: ctx.now }));

/**
 * A reply ended for good (finished, failed or stopped — never at a pause): drop the ciphertext of the thread's saved
 * references. The rows stay, so a late spend reads `used`. Best effort from the caller; whatever it misses waits for
 * the sweep below, which runs per shard when the shard was active.
 */
export const discardSecretsOfThread = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx }) => {
        await discardThreadSecrets(ctx, { threadId });

        return null;
    });

/** Housekeeping sweep (`shardSweeps()`): drops references past their 24 hours, spent or not. */
export const sweepRequestedSecrets = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        await sweepExpiredSecrets(ctx, ctx.now, SWEEP_BATCH);

        return null;
    });
