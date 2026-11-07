/**
 * A generated thread title: where its prompt is read from, the checks it must pass, and its write.
 *
 * The prompt is the earliest successful user prompt within the last {@link TITLE_READ_WINDOW} rows of the thread's active path: the
 * rows the model sees as the conversation, so a long chat is titled from what it is about now, not from a prompt long out of view. The
 * read and every check are bounded by that window, so no title read or write walks a whole long path.
 *
 * A title run reads its prompt when it runs (`readTitlePrompt`), not when it was asked for: a branch switched since is the one it titles.
 * Its last step before the model is {@link admitTitleRun}, which checks the thread (lock, deletion, host-run, rename, the prompt still in
 * view, the requester's access) and takes the run's charge in ONE transaction.
 *
 * A locked thread's prompt is never sent. Each model request a title run makes takes a dispatch claim ({@link beginTitleDispatch}) in the
 * same transaction that checks the thread is not locked, and holds it until the request has been answered; locking a chat
 * (`enableThreadLock`) refuses while one is held ({@link titleDispatchInFlight}). Either the lock commits first and no request is sent, or
 * the request goes out first, while the chat was still unlocked, and the lock waits for it.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { type ContextRow, firstUserPrompt } from "../chat/lib/first-user-prompt";
import { threadGateOutcome } from "../chat/lib/thread-gate";
import {
    claimFence,
    claimRow,
    dropExpiredClaimsWithPrefix,
    hasClaimWithPrefix,
    recordClaimResult,
    releaseClaim,
    releaseClaimsWithPrefix,
} from "../lib/claim-once";
import { sha256Hex } from "../lib/crypto";
import { isThreadLocked } from "../lib/thread-lock";
import { MAX_LENGTH } from "../lib/validators";
import { resolveLeafRow, walkPath } from "./branch-rows";
import { getMaxMessage } from "./messages";
import { DEFAULT_RECENT_MESSAGES } from "./shared";

type Reader = Pick<QueryContext, "db">;

/**
 * The rows a title is read from and checked against: the tail of the active path, as many SUCCESSFUL rows as the model's context holds
 * (failed rows are not in the model's context, so they do not use up the window).
 */
export const TITLE_READ_WINDOW = DEFAULT_RECENT_MESSAGES;

/** How many stored rows a title read or check walks to find its window: room for failed rows among the window's successful ones. */
const TITLE_WALK_LIMIT = 2 * TITLE_READ_WINDOW;

const isSuccessful = (row: Doc<"messages">): boolean => row.status === "success";

/** One admission per title run for billing (`idempotencyClaims`): a retried run finds it, so its model call is not billed twice. */
export const TITLE_CHARGE_SCOPE = "title-charge";
export const TITLE_CHARGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The model's answer for a title run whose write has not settled yet, keyed by the run's charge key (which starts with the thread id).
 * A row exists only from the answer to the write: settling, refusing or locking deletes it, so a chat's rows stay few.
 */
export const TITLE_ANSWER_SCOPE = "title-answer";

/** The answer recorded for a run, or `undefined` when none is pending. */
const recordedAnswer = async (ctx: Reader, chargeKey: string): Promise<TitleAnswer | undefined> => {
    const row = await claimRow(ctx, TITLE_ANSWER_SCOPE, chargeKey);

    return parseAnswer(row?.result);
};

/** Drops the answer recorded for a run: its write has settled, or it can no longer be written. */
const dropAnswer = async (ctx: Pick<MutationContext, "db">, chargeKey: string): Promise<void> => {
    await releaseClaim(ctx, TITLE_ANSWER_SCOPE, chargeKey);
};

/**
 * A title model request being sent: `<threadId>:<request id>`, held from the last lock check until the request is answered. Its TTL only
 * matters when the run dies mid-request: locking the chat is refused until it lapses.
 */
export const TITLE_DISPATCH_SCOPE = "title-dispatch";
export const TITLE_DISPATCH_TTL_MS = 2 * 60 * 1000;

/** How long before its dispatch claim lapses a title request is aborted: the request has ended, and released its claim, before the lapse. */
export const TITLE_DISPATCH_MARGIN_MS = 15 * 1000;

/** The least time a title request is given: one with less left before its deadline is not sent. */
export const TITLE_REQUEST_MIN_MS = 15 * 1000;

/** When a title request whose dispatch claim was taken at `claimedAt` is aborted: before the claim can lapse, so the claim covers the whole request. */
export const titleRequestDeadline = (claimedAt: number): number => claimedAt + TITLE_DISPATCH_TTL_MS - TITLE_DISPATCH_MARGIN_MS;

/** Whether a request whose dispatch claim was taken at `claimedAt` may still be sent at `now`: it has at least {@link TITLE_REQUEST_MIN_MS} before its deadline. */
export const dispatchStillHeld = (claimedAt: number, now: number = Date.now()): boolean => titleRequestDeadline(claimedAt) - now >= TITLE_REQUEST_MIN_MS;

/** The row the thread view ends at: the stored leaf (or the path it falls back to when that row is gone), else the latest row. */
const leafOf = async (context: Reader, thread: Doc<"threads">): Promise<Doc<"messages"> | null> =>
    thread.activeLeafMessageId === undefined
        ? await getMaxMessage(context as QueryContext, thread._id)
        : await resolveLeafRow(context, thread._id, thread.activeLeafMessageId);

/** A thread no background title may read or write: gone, locked, deleted or host-run. */
const closedToTitles = (thread: Doc<"threads"> | null): thread is null =>
    !thread || isThreadLocked(thread) || thread.runner === "host" || thread.deletedAt !== undefined;

/** The earliest successful user prompt within the active path's last {@link TITLE_READ_WINDOW} rows, or `undefined` when there is none. */
export const titlePromptIn = async (context: Reader, thread: Doc<"threads">): Promise<{ id: string | undefined; text: string } | undefined> => {
    const leaf = await leafOf(context, thread);

    if (!leaf) {
        return undefined;
    }

    const { rows } = await walkPath(context, thread._id, leaf, { limit: TITLE_WALK_LIMIT });
    const window = rows.filter((row) => isSuccessful(row)).slice(0, TITLE_READ_WINDOW);

    // A stored row's `message` is untyped; the prompt reader takes it as the user/assistant message it is.
    return firstUserPrompt(window.toReversed() as ContextRow[]);
};

/**
 * Whether `promptId` may still be a title's source: a user prompt of this thread that did not fail and, when `inWindow` is set, within
 * the last {@link TITLE_READ_WINDOW} rows of the active path. A deleted prompt is always refused; with `inWindow`, so are one left on
 * another branch and one the chat has moved past. The walk stops at the prompt, so it reads only the rows after it.
 */
export const promptInView = async (context: Reader, thread: Doc<"threads">, promptId: string, inWindow = true): Promise<boolean> => {
    const prompt = await context.db.get("messages", promptId as Id<"messages">);

    if (!prompt || prompt.threadId !== thread._id || (prompt.message as { role?: string } | undefined)?.role !== "user" || prompt.status === "failed") {
        return false;
    }

    if (!inWindow) {
        return true;
    }

    const leaf = await leafOf(context, thread);

    if (!leaf) {
        return false;
    }

    if (leaf._id === prompt._id) {
        return true;
    }

    // The walk stops on the prompt (`next`); the successful rows passed on the way are the window's rows before it, so the prompt is in
    // the window when there are at most WINDOW - 1 of them.
    const { next, rows } = await walkPath(context, thread._id, leaf, { limit: TITLE_WALK_LIMIT, stopAtId: promptId });

    return next?._id === promptId && rows.filter((row) => isSuccessful(row)).length <= TITLE_READ_WINDOW - 1;
};

interface TitleCheck {
    /** The digest of the title the run read: another title by now means the owner renamed the thread meanwhile, and the rename stays. */
    expectedTitleDigest: string;
    /**
     * The prompt the title comes from ({@link promptInView}). A regenerate's (one with a `requestedBy`) must still be in the window; an
     * automatic title's need only still be there: its job may start after a long first reply has pushed the prompt out of the window.
     */
    promptId?: string;
    /** The user who asked for a regenerate, who must still hold admin access. */
    requestedBy?: string;
    threadId: Id<"threads">;
}

/** Why a title may not be generated or written for this thread now, or `undefined` when it may. Reads only, in the caller's transaction. */
export const titleBlockedIn = async (context: Reader, check: TitleCheck): Promise<string | undefined> => {
    const thread = await context.db.get("threads", check.threadId);

    if (closedToTitles(thread)) {
        return "ineligible";
    }

    if ((await sha256Hex(thread.title ?? "")) !== check.expectedTitleDigest) {
        return "renamed-meanwhile";
    }

    if (check.promptId !== undefined && !(await promptInView(context, thread, check.promptId, check.requestedBy !== undefined))) {
        return "prompt-moved";
    }

    if (
        check.requestedBy !== undefined &&
        (await threadGateOutcome(context, { level: "admin", threadId: check.threadId, userId: check.requestedBy })) !== "ok"
    ) {
        return "access-withdrawn";
    }

    return undefined;
};

/**
 * The prompt a regenerate titles from, read when the job runs. A thread closed to titles, or a requester without admin access, is
 * refused before any message is read.
 */
export const readTitlePrompt = internalQuery
    .input({ requestedBy: v.string(), threadId: v.id("threads") })
    .output(
        v.union(
            v.object({ outcome: v.literal("refused") }),
            v.object({ outcome: v.literal("none") }),
            v.object({ id: v.optional(v.string()), outcome: v.literal("prompt"), text: v.string() }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        if (closedToTitles(thread) || (await threadGateOutcome(ctx, { level: "admin", threadId: args.threadId, userId: args.requestedBy })) !== "ok") {
            return { outcome: "refused" as const };
        }

        const prompt = await titlePromptIn(ctx, thread);

        return prompt ? { id: prompt.id, outcome: "prompt" as const, text: prompt.text } : { outcome: "none" as const };
    });

/** What a title run stores on its charge once the model has answered: enough for a retry to write it without asking again. */
interface TitleAnswer {
    promptId?: string;
    title: string;
}

const parseAnswer = (result: string | undefined): TitleAnswer | undefined => {
    if (result === undefined) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(result) as Partial<TitleAnswer>;

        return typeof parsed.title === "string"
            ? { promptId: typeof parsed.promptId === "string" ? parsed.promptId : undefined, title: parsed.title }
            : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The last step before a title's model call: checks the thread ({@link titleBlockedIn}) and takes the run's charge, in one transaction.
 *
 * - `refused`: the thread may not be titled now (locked, renamed, the prompt moved, …); nothing is charged.
 * - `admitted`: the charge is taken; the caller calls the model, records its answer ({@link recordTitleAnswer}) and writes it.
 * - `answered`: an earlier try of this run was charged and its answer recorded; the caller writes that answer, with no model call.
 * - `in-flight`: an earlier try was charged and recorded no answer (it is still running, or died mid-call); nothing is called again.
 *
 * A resumed answer is checked against the prompt it was generated from, not the one this try read.
 */
export const admitTitleRun = internalMutation
    .input({
        chargeKey: v.string().max(MAX_LENGTH.short),
        expectedTitleDigest: v.string().max(MAX_LENGTH.short),
        promptId: v.optional(v.string().max(MAX_LENGTH.id)),
        requestedBy: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.id("threads"),
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(
        v.union(
            v.object({ outcome: v.literal("refused"), reason: v.string() }),
            v.object({ claimedAt: v.number(), outcome: v.literal("admitted") }),
            v.object({ claimedAt: v.number(), outcome: v.literal("answered"), promptId: v.optional(v.string()), title: v.string() }),
            v.object({ outcome: v.literal("in-flight") }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const existing = await claimRow(ctx, TITLE_CHARGE_SCOPE, args.chargeKey);
        const answer = existing ? await recordedAnswer(ctx, args.chargeKey) : undefined;
        const reason = await titleBlockedIn(ctx, { ...args, promptId: answer ? answer.promptId : args.promptId });

        if (reason !== undefined) {
            // A recorded answer that can no longer be written is not kept: a chat locked or deleted since keeps no copy of it.
            if (answer) {
                await dropAnswer(ctx, args.chargeKey);
            }

            return { outcome: "refused" as const, reason };
        }

        if (existing) {
            return answer
                ? { claimedAt: existing.claimedAt, outcome: "answered" as const, promptId: answer.promptId, title: answer.title }
                : { outcome: "in-flight" as const };
        }

        const claimedAt = await claimFence(ctx, TITLE_CHARGE_SCOPE, args.chargeKey, { ttlMs: TITLE_CHARGE_TTL_MS, userId: args.userId });

        return claimedAt === null ? { outcome: "in-flight" as const } : { claimedAt, outcome: "admitted" as const };
    });

/**
 * Records a run's answer while the run still holds its charge (`claimedAt`), tagged with the charge's user so erasing the account
 * erases it. `false` when the charge is no longer the run's.
 */
const recordAnswer = async (
    ctx: Pick<MutationContext, "db">,
    args: { chargeKey: string; claimedAt: number; promptId?: string; title: string },
): Promise<boolean> => {
    const charge = await claimRow(ctx, TITLE_CHARGE_SCOPE, args.chargeKey);

    if (charge?.claimedAt !== args.claimedAt) {
        return false;
    }

    await dropAnswer(ctx, args.chargeKey);

    const recordedAt = await claimFence(ctx, TITLE_ANSWER_SCOPE, args.chargeKey, { ttlMs: TITLE_CHARGE_TTL_MS, userId: charge.userId });

    return (
        recordedAt !== null &&
        (await recordClaimResult(ctx, TITLE_ANSWER_SCOPE, args.chargeKey, recordedAt, JSON.stringify({ promptId: args.promptId, title: args.title })))
    );
};

/** Stores the model's answer for the run (fenced by `claimedAt`), so a write that fails resumes from it. */
export const recordTitleAnswer = internalMutation
    .input({
        chargeKey: v.string().max(MAX_LENGTH.short),
        claimedAt: v.number(),
        promptId: v.optional(v.string().max(MAX_LENGTH.id)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await recordAnswer(ctx, args));

/**
 * Writes a generated title while {@link titleBlockedIn} still lets it, all read in the same transaction as the patch. Answers whether the
 * title is on the thread.
 */
export const writeTitleIfUnchanged = async (ctx: Pick<MutationContext, "db">, arguments_: TitleCheck & { title: string }): Promise<boolean> => {
    const thread = await ctx.db.get("threads", arguments_.threadId);

    // A blank title is no title: whatever wrote it, the chat keeps the one it has.
    if (!thread || arguments_.title.trim() === "") {
        return false;
    }

    // A title that already reads as this one landed in an earlier try whose response was lost: it is saved, whatever has happened to the
    // thread since. Without this the retry would see the digest moved and refuse a title that is already there.
    if (thread.title === arguments_.title) {
        return true;
    }

    if ((await titleBlockedIn(ctx, arguments_)) !== undefined) {
        return false;
    }

    await ctx.db.patch("threads", arguments_.threadId, { title: arguments_.title });

    return true;
};

/**
 * Writes a generated title ({@link writeTitleIfUnchanged}). The run is settled either way, so the answer recorded on its charge
 * (`chargeKey`) is dropped in the same transaction: it lives only between the model's answer and the write.
 */
export const setGeneratedTitle = internalMutation
    .input({
        chargeKey: v.optional(v.string().max(MAX_LENGTH.short)),
        expectedTitleDigest: v.string().max(MAX_LENGTH.short),
        promptId: v.optional(v.string().max(MAX_LENGTH.id)),
        requestedBy: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.id("threads"),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const { chargeKey, ...check } = args;
        const written = await writeTitleIfUnchanged(ctx, check);

        if (chargeKey !== undefined) {
            await dropAnswer(ctx, chargeKey);
        }

        return written;
    });

/**
 * Writes the answer recorded on a title run's charge, for a run whose own write kept failing: the same checks as any title write
 * ({@link writeTitleIfUnchanged}), against the prompt the answer came from, and the answer is dropped in the same transaction. `none`
 * when no answer is recorded (it was written or dropped already).
 */
export const writeRecordedTitle = internalMutation
    .input({
        chargeKey: v.string().max(MAX_LENGTH.short),
        expectedTitleDigest: v.string().max(MAX_LENGTH.short),
        requestedBy: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.id("threads"),
    })
    .output(v.union(v.literal("written"), v.literal("refused"), v.literal("none")))
    .mutation(async ({ args, ctx }) => {
        const answer = await recordedAnswer(ctx, args.chargeKey);

        if (!answer) {
            return "none" as const;
        }

        const written = await writeTitleIfUnchanged(ctx, {
            expectedTitleDigest: args.expectedTitleDigest,
            promptId: answer.promptId,
            requestedBy: args.requestedBy,
            threadId: args.threadId,
            title: answer.title,
        });

        await dropAnswer(ctx, args.chargeKey);

        return written ? ("written" as const) : ("refused" as const);
    });

/** Whether a title model request for this thread is being sent: locking the chat waits until none is. */
export const titleDispatchInFlight = async (context: Reader, threadId: Id<"threads">): Promise<boolean> =>
    await hasClaimWithPrefix(context, TITLE_DISPATCH_SCOPE, `${threadId}:`);

/**
 * Lets one title model request leave: checks that the thread is not closed to titles and takes the request's dispatch claim, in one
 * transaction. The claim's `claimedAt`, or `null` when the request must not be sent.
 */
export const beginTitleDispatch = internalMutation
    .input({ requestId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads") })
    .output(v.union(v.null(), v.number()))
    .mutation(async ({ args, ctx }) => {
        if (closedToTitles(await ctx.db.get("threads", args.threadId))) {
            return null;
        }

        // Dispatches whose release never landed are cleared here, so the lock's check reads a short range.
        await dropExpiredClaimsWithPrefix(ctx, TITLE_DISPATCH_SCOPE, `${args.threadId}:`);

        return await claimFence(ctx, TITLE_DISPATCH_SCOPE, `${args.threadId}:${args.requestId}`, { ttlMs: TITLE_DISPATCH_TTL_MS });
    });

/** The request has been answered: its dispatch claim goes, and the chat may be locked again. */
export const endTitleDispatch = internalMutation
    .input({ claimedAt: v.number(), requestId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await releaseClaim(ctx, TITLE_DISPATCH_SCOPE, `${args.threadId}:${args.requestId}`, args.claimedAt);

        return null;
    });

/**
 * Drops every title answer still pending for this thread: a chat being locked keeps no copy of a title made from its content. Only runs
 * whose write has not settled have a row, so the delete is short; past one batch, the rest is deleted by a scheduled purge, and nothing
 * reads them meanwhile (every reader refuses a locked chat).
 */
export const clearRecordedTitleAnswers = async (ctx: Pick<MutationContext, "db" | "scheduler">, threadId: Id<"threads">): Promise<void> => {
    const prefix = `${threadId}:`;

    if (await releaseClaimsWithPrefix(ctx, TITLE_ANSWER_SCOPE, prefix)) {
        await ctx.scheduler.runAfter(0, internal.lib.claim_once.purgeClaimsWithPrefix, { prefix, scope: TITLE_ANSWER_SCOPE });
    }
};
