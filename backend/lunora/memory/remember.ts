/**
 * "Remember this": the user asks in chat and the model only triggers the save. The fact is worded here, by the extractor
 * in its requested mode (`extract.ts`) over the turn's own typed prompt, and saved through extraction's own gate and
 * write: the typed quote, the privacy marker, secret and health handling, dedup, and `saveMemoryBatch`.
 *
 * Refused unless memory is on, the chat is the user's alone (not shared, public, a group, a messenger conversation, a
 * temporary or locked chat, or a sub-agent's or worker's thread), and the prompt is one the user just sent: a row of
 * another run under it means it was answered before (a regenerate, or a prompt a task or sub-agent wrote).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { internalAction, internalQuery } from "../_generated/server";
import { typedTextOf } from "../chat/lib/attached-text";
import { type ExtractionOutcome, vRunFact } from "./extract";
import { checkRequestedSource, REMEMBER_SCOPE, type RequestedRefusal, vRequestedRefusal } from "./functions";
import { hasPrivacyMarker } from "./gate";

/** One request per prompt (`REMEMBER_SCOPE`): a second call for the same message, parallel or later, does not ask again. */
const REMEMBER_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export const vRememberStatus = v.union(
    v.literal("saved"),
    v.literal("already_known"),
    v.literal("nothing_asked"),
    v.literal("refused"),
    v.literal("already_requested"),
    v.literal("memory_off"),
    v.literal("not_private"),
    v.literal("not_your_words"),
    v.literal("private_marker"),
    v.literal("unavailable"),
);

export type RememberStatus = Infer<typeof vRememberStatus>;

/** The facts the run wrote, what became of what was asked, and the refusal that stopped the request after them, if one did. */
export type RememberResult = { facts: ExtractionOutcome["facts"]; status: RememberStatus; stopped?: RequestedRefusal };

/**
 * What the extractor's run comes to for the tool, and whether the prompt's claim stays: it does when something was written
 * or nothing was asked, so the message is handled and the turn's later extraction leaves its prompt alone. Anything else
 * (the model never asked, a refusal before any write, the evidence gate refusing what was found) releases it.
 */
export const rememberResultOf = (outcome: ExtractionOutcome): { keepClaim: boolean; result: RememberResult } => {
    if (!outcome.asked) {
        return { keepClaim: false, result: { facts: [], status: "unavailable" } };
    }

    if (outcome.facts.length > 0) {
        const asked = outcome.facts.filter((fact) => fact.asked);
        let status: RememberStatus = "saved";

        if (asked.length === 0) {
            status = "nothing_asked";
        } else if (asked.every((fact) => fact.status === "known")) {
            status = "already_known";
        }

        return { keepClaim: true, result: { facts: outcome.facts, status, ...(outcome.blocked !== undefined && { stopped: outcome.blocked }) } };
    }

    if (outcome.blocked !== undefined || outcome.refused > 0) {
        return { keepClaim: false, result: { facts: [], status: outcome.blocked ?? "refused" } };
    }

    return { keepClaim: true, result: { facts: [], status: "nothing_asked" } };
};

type SourceArgs = { now: number; promptMessageId: string; replyKey?: string; threadId: Id<"threads">; userId: string };

type Source = { botId: string | undefined; promptAt: number; raw: string; typed: string };

/** The turn's prompt as a source for a remembered fact (`checkRequestedSource`), or why it is none. */
const readSource = async (ctx: Pick<QueryCtx, "db">, { now, ...source }: SourceArgs): Promise<{ reason: RequestedRefusal } | { source: Source }> => {
    const check = await checkRequestedSource(ctx, source, now);

    if ("refused" in check) {
        return { reason: check.refused };
    }

    const { prompt, thread } = check;
    // A deleted bot's scope is not written to: the fact is the user's own then, as a chat with no bot.
    const bot = thread.botId ? await ctx.db.get("bots", thread.botId) : null;
    const typed = typedTextOf(prompt.message as Parameters<typeof typedTextOf>[0]);

    return {
        source: {
            botId: bot?.userId === source.userId ? (thread.botId as string) : undefined,
            promptAt: prompt._creationTime,
            raw: prompt.text ?? typed,
            typed,
        },
    };
};

const vSourceArgs = {
    // From the action: a query reads no clock of its own.
    now: v.number(),
    promptMessageId: v.string(),
    replyKey: v.optional(v.string()),
    threadId: v.id("threads"),
    userId: v.string(),
};

const vSource = v.object({ botId: v.optional(v.string()), promptAt: v.number(), raw: v.string(), typed: v.string() });

export const readRememberSource = internalQuery
    .input({ ...vSourceArgs })
    .output(v.union(v.object({ reason: vRequestedRefusal }), v.object({ source: vSource })))
    .query(async ({ args, ctx }) => await readSource(ctx, args));

/** Reads the source, takes the prompt's one request, and runs the extractor in its requested mode over the typed prompt. */
export const rememberFactFor = async (ctx: ActionCtx, args: Omit<SourceArgs, "now">): Promise<RememberResult> => {
    const read = await ctx.runQuery(internal.memory.remember.readRememberSource, { ...args, now: Date.now() });

    if ("reason" in read) {
        return { facts: [], status: read.reason };
    }

    const { botId, promptAt, raw, typed } = read.source;

    // The marker opts the whole message out, wherever it sits in it.
    if (hasPrivacyMarker(raw)) {
        return { facts: [], status: "private_marker" };
    }

    if (typed.trim() === "") {
        return { facts: [], status: "not_your_words" };
    }

    const claim = { key: args.promptMessageId, scope: REMEMBER_SCOPE };

    if (!(await ctx.runMutation(internal.lib.claim_once.claimKey, { ...claim, ttlMs: REMEMBER_CLAIM_TTL_MS, userId: args.userId }))) {
        return { facts: [], status: "already_requested" };
    }

    let outcome: ExtractionOutcome;

    try {
        outcome = await ctx.runAction(internal.memory.extract.extractMemories, {
            assistantResponse: "",
            botId,
            messageAt: promptAt,
            promptAt,
            promptMessageId: args.promptMessageId,
            quotablePrompt: typed,
            replyKey: args.replyKey,
            requested: true,
            threadId: args.threadId,
            userId: args.userId,
            userMessage: raw,
        });
    } catch (error) {
        await ctx.runMutation(internal.lib.claim_once.releaseKey, claim);

        throw error;
    }

    const { keepClaim, result } = rememberResultOf(outcome);

    if (!keepClaim) {
        await ctx.runMutation(internal.lib.claim_once.releaseKey, claim);
    }

    return result;
};

/** The `remember` tool's save, run on the user's own shard. */
export const rememberFact = internalAction
    .input({ promptMessageId: v.string(), replyKey: v.optional(v.string()), threadId: v.id("threads"), userId: v.string() })
    .output(v.object({ facts: v.array(vRunFact), status: vRememberStatus, stopped: v.optional(vRequestedRefusal) }))
    .action(async ({ args, ctx }) => await rememberFactFor(ctx, args));
