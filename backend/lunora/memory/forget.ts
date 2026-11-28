/**
 * "Forget that": the user asks in chat, the model describes what to forget, and the server finds it with the memory
 * search (`retrieve.ts`) over what this chat's run can see: the user's own memories and this bot's. Deleted only through
 * the one delete path (`deleteMemoryRows`), and only under the rules a remembered fact is written by
 * (`checkRequestedSource`): memory on, the owner's private typed chat, the turn's own fresh prompt.
 *
 * A lookup never deletes: it hands back candidates, and the model calls the tool again with the ones meant, a call that
 * always waits for the user's approval (`chat/tools/forget.ts`). Text the model read (a page, a tool result, a document)
 * can steer what it asks for, so only the user's click deletes. Every id is checked again in the write that deletes it.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { checkRequestedSource, deleteMemoryRows, markForgetPrompt, type RequestedSource, textKey, vRequestedSource } from "./functions";
import { typedTextOf } from "../chat/lib/attached-text";
import { hasPrivacyMarker } from "./gate";
import { dropRememberDispatch, takeRememberDispatch } from "./remember-dispatch";
import { scopesOf } from "./retrieve-ranking";

/** Candidates handed back for the user to confirm, and memories one confirmed call deletes. */
export const FORGET_MAX_CANDIDATES = 5;

export const vForgetStatus = v.union(
    v.literal("deleted"),
    v.literal("needs_confirmation"),
    v.literal("nothing_found"),
    v.literal("memory_off"),
    v.literal("not_private"),
    v.literal("not_your_request"),
    v.literal("private_message"),
    v.literal("unavailable"),
);

export type ForgetStatus = Infer<typeof vForgetStatus>;

const vCandidate = v.object({ id: v.string(), text: v.string() });

export type ForgetCandidate = Infer<typeof vCandidate>;

/**
 * What a call did: the texts deleted, the candidates still to confirm, confirmed memories that changed since the user was
 * asked (their current versions are among the candidates), and confirmed ids no longer there at all.
 */
export type ForgetResult = {
    candidates?: ForgetCandidate[];
    changed?: number;
    deleted: string[];
    /** How many were deleted, when their texts are withheld (`deleted` is then empty): the chat is no longer the user's alone. */
    deletedCount?: number;
    gone?: number;
    /** Of `gone`, those merged into another memory that matches nothing to offer: the user can ask again in their own words. */
    merged?: number;
    status: ForgetStatus;
    /** Confirmed memories that changed and could not be checked now, neither deleted nor offered: the user can ask again in a moment. */
    unchecked?: number;
};

/** Newer versions a confirmed memory's supersede chain is followed through to reach the one in effect. */
const SUCCESSOR_HOPS = 20;

type Found = { memory: string; memoryId: string; relevance: number };

/**
 * The candidates the user is asked to confirm, best first by relevance alone (the better of the vector cosine and the
 * keyword share), never by the search's `score`, which adds recency and confidence.
 */
export const forgetCandidates = (found: ReadonlyArray<Found>): ForgetCandidate[] =>
    found
        .toSorted((a, b) => b.relevance - a.relevance)
        .slice(0, FORGET_MAX_CANDIDATES)
        .map((row) => {
            return { id: row.memoryId, text: row.memory };
        });

const statusOf = (refused: "memory_off" | "not_private" | "not_your_words"): ForgetStatus => (refused === "not_your_words" ? "not_your_request" : refused);

/** Whether the user's message opts out of memory with a privacy marker, anywhere in it (as for `remember`): nothing is read or written. */
const markedPrivate = (prompt: Doc<"messages">): boolean => hasPrivacyMarker(prompt.text ?? typedTextOf(prompt.message as Parameters<typeof typedTextOf>[0]));

/** The bot whose memories this chat sees beside the user's own: the chat's bot, while the user still owns it. */
const botScopeOf = async (ctx: Pick<MutationCtx, "db">, thread: Doc<"threads">, userId: string): Promise<string | undefined> => {
    const bot = thread.botId ? await ctx.db.get("bots", thread.botId) : null;

    return bot?.userId === userId ? (thread.botId as string) : undefined;
};

/**
 * Lets the lookup's embedding call leave: checks the source and takes the chat's dispatch claim in one transaction, as a
 * remember request does (`beginRememberDispatch`), so locking the chat waits until the call is answered.
 */
export const beginForgetLookup = internalMutation
    .input({ lookup: v.string(), requested: vRequestedSource })
    .output(v.union(v.object({ botId: v.optional(v.string()), expiresAt: v.number() }), v.object({ refused: vForgetStatus })))
    .mutation(async ({ args, ctx }) => {
        const check = await checkRequestedSource(ctx, args.requested, ctx.now);

        if ("refused" in check) {
            return { refused: statusOf(check.refused) };
        }

        if (markedPrivate(check.prompt)) {
            return { refused: "private_message" as const };
        }

        const claim = await takeRememberDispatch(ctx, args.requested.threadId, args.requested.promptMessageId, args.lookup);

        if (claim === null) {
            return { refused: "unavailable" as const };
        }

        // The message asks to forget, whatever the lookup finds: the reply's extraction reads only its steers.
        await markForgetPrompt(ctx, args.requested.promptMessageId, args.requested.userId);

        return { botId: await botScopeOf(ctx, check.thread, args.requested.userId), expiresAt: claim.expiresAt };
    });

/** Releases the lookup's dispatch claim; a claim never released lapses on its own. */
export const endForgetLookup = internalMutation
    .input({ lookup: v.string(), promptMessageId: v.string(), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await dropRememberDispatch(ctx, { promptMessageId: args.promptMessageId, request: args.lookup, threadId: args.threadId });

        return null;
    });

/**
 * Checks the source again once the search is done, before its candidates' texts leave: a chat shared, locked or switched
 * off during the search shows its memories to nobody. A mutation, so the grants are read from the primary.
 */
export const recheckForgetSource = internalMutation
    .input({ requested: vRequestedSource })
    .output(v.union(v.null(), vForgetStatus))
    .mutation(async ({ args, ctx }) => {
        const check = await checkRequestedSource(ctx, args.requested, ctx.now);

        return "refused" in check ? statusOf(check.refused) : null;
    });

/**
 * Deletes the given memories after checking, in this write, the source again and each id: the user's own row, of a scope
 * this chat sees, still active, and still reading as the text the call was given (what the user saw). Ids given twice
 * count once. A memory superseded since is not deleted: the one now in effect (`successors`, followed through its supersede
 * chain; `changed` counts the confirmed ids that led to one this delete does not remove) or, for a row retired into a
 * merge that leaves no pointer (compression), the approved text (`retired`) comes back, so the user is asked again about
 * what memory holds now.
 */
export const deleteForgotten = internalMutation
    .input({ memories: v.array(vCandidate), requested: vRequestedSource })
    .output(
        v.union(
            v.object({
                changed: v.number(),
                deleted: v.array(v.string()),
                gone: v.number(),
                retired: v.array(v.string()),
                successors: v.array(vCandidate),
            }),
            v.object({ refused: vForgetStatus }),
        ),
    )
    .mutation(async ({ args: { memories, requested }, ctx }) => {
        const check = await checkRequestedSource(ctx, requested, ctx.now);

        if ("refused" in check) {
            return { refused: statusOf(check.refused) };
        }

        if (markedPrivate(check.prompt)) {
            return { refused: "private_message" as const };
        }

        const { userId } = requested;

        // The message asks to forget, whatever is still there to delete: the reply's extraction reads only its steers.
        await markForgetPrompt(ctx, requested.promptMessageId, userId);

        const scopes = scopesOf({ botId: await botScopeOf(ctx, check.thread, userId), includeUserWide: true });
        const visible = (row: Doc<"memories"> | null): row is Doc<"memories"> =>
            row !== null && row.userId === userId && scopes.includes((row.botId as string | undefined) ?? null);
        const rows: Doc<"memories">[] = [];
        // The version in effect each superseded id led to, one entry per confirmed id (several may share one).
        const successors: Doc<"memories">[] = [];
        const retired: string[] = [];
        // Every text each id was confirmed with: an id named twice is one memory, and it is deleted only if all of them match.
        const textsById = new Map<string, string[]>();

        for (const { id, text } of memories) {
            textsById.set(id, [...(textsById.get(id) ?? []), text]);
        }

        const named = [...textsById].slice(0, FORGET_MAX_CANDIDATES);

        for (const [id, texts] of named) {
            const text = texts[0] as string;
            const memoryId = ctx.db.normalizeId("memories", id);
            const row = memoryId ? await ctx.db.get("memories", memoryId) : null;

            if (!visible(row)) {
                continue;
            }

            if (!row.supersededBy) {
                // Edited in place since the user was asked: what it reads now is offered again, not deleted.
                if (texts.every((shown) => textKey(row.memory) === textKey(shown))) {
                    rows.push(row);
                } else {
                    successors.push(row);
                }

                continue;
            }

            // Superseded since the user was asked: walk to the version in effect. A row retired by itself (compression,
            // decay, expiry) names no successor.
            let current: Doc<"memories"> | null = row;

            for (let hop = 0; hop < SUCCESSOR_HOPS && current?.supersededBy && current.supersededBy !== current._id; hop += 1) {
                const next: Doc<"memories"> | null = await ctx.db.get("memories", current.supersededBy);

                current = visible(next) ? next : null;
            }

            if (current && !current.supersededBy) {
                successors.push(current);
            } else if (current !== null && current.supersededBy === current._id) {
                retired.push(text);
            }
        }

        if (rows.length > 0) {
            const { olderVersions } = await deleteMemoryRows(ctx, rows, userId);

            ctx.log.event("memory.forget", { deleted: rows.length, olderVersions });
        }

        // A successor this delete removes (another confirmed id named it) is gone with it: neither offered nor counted as changed.
        const deleting = new Set<string>(rows.map((row) => row._id));
        const changed = successors.filter((successor) => !deleting.has(successor._id));
        const offered = new Map(changed.map((successor) => [successor._id as string, { id: successor._id as string, text: successor.memory }]));

        return {
            changed: changed.length,
            deleted: rows.map((row) => row.memory),
            gone: named.length - rows.length - successors.length - retired.length,
            retired,
            successors: [...offered.values()],
        };
    });

type ForgetArgs = RequestedSource & { memories?: ForgetCandidate[]; query?: string };

/** Searches for what `query` describes under the chat's dispatch claim, and checks the source again before anything is returned. */
const search = async (ctx: ActionCtx, requested: RequestedSource, query: string): Promise<{ found: Found[] } | { refused: ForgetStatus }> => {
    const lookup = crypto.randomUUID();
    const begun = await ctx.runMutation(internal.memory.forget.beginForgetLookup, { lookup, requested });

    if ("refused" in begun) {
        return begun;
    }

    let found: Found[];

    try {
        found = await ctx.runAction(internal.memory.retrieve.retrieveRelevantMemories, {
            botId: begun.botId,
            dispatchExpiresAt: begun.expiresAt,
            limit: FORGET_MAX_CANDIDATES,
            orderByRelevance: true,
            search: true,
            searchText: query,
            userId: requested.userId,
        });
    } finally {
        // The search's only model call is answered: the chat may be locked again before the delete, which checks the source itself.
        await ctx
            .runMutation(internal.memory.forget.endForgetLookup, { lookup, promptMessageId: requested.promptMessageId, threadId: requested.threadId })
            .catch((error: unknown) => {
                console.warn("[memory/forget] The chat's dispatch claim could not be released; it lapses on its own:", error);
            });
    }

    const refused = await ctx.runMutation(internal.memory.forget.recheckForgetSource, { requested });

    return refused === null ? { found } : { refused };
};

/**
 * Deletes the memories the user confirmed. Those that changed since they were asked are offered again: their current
 * versions, and for one merged away (compression) what a search for the approved text finds now.
 */
const deleteConfirmed = async (ctx: ActionCtx, requested: RequestedSource, memories: ForgetCandidate[]): Promise<ForgetResult> => {
    const outcome = await ctx.runMutation(internal.memory.forget.deleteForgotten, { memories, requested });

    if ("refused" in outcome) {
        return { deleted: [], status: outcome.refused };
    }

    let offered = outcome.successors;
    // Confirmed ids compression retired whose search found no merged row to offer: counted as gone.
    let unresolved = 0;
    // Confirmed ids compression retired that could not be looked up now (the search failed, or the chat's claim was taken).
    let unchecked = 0;
    // Why no memory text may leave: the chat stopped being the user's alone after the delete committed, or that could not be checked.
    let withheld: ForgetStatus | undefined;

    if (outcome.retired.length > 0) {
        // The deletes above are committed: a failed search must not lose them.
        const searched = await search(ctx, requested, outcome.retired.join("\n")).catch((error: unknown) => {
            console.warn("[memory/forget] The search for merged memories failed; what was deleted stands:", error);

            return { refused: "unavailable" as const };
        });

        if ("found" in searched) {
            const found = forgetCandidates(searched.found);
            const known = new Set(offered.map((candidate) => candidate.id));

            // Whether the search matched decides the count; a match another id already offered is shown once.
            unresolved = found.length === 0 ? outcome.retired.length : 0;
            offered = [...offered, ...found.filter((candidate) => !known.has(candidate.id))];
        } else if (searched.refused === "unavailable") {
            unchecked = outcome.retired.length;
            // The search never reached its own privacy recheck: it is made here, and one that fails counts as a refusal.
            const recheck = await ctx.runMutation(internal.memory.forget.recheckForgetSource, { requested }).catch(() => "unavailable" as const);

            withheld = recheck ?? undefined;
        } else {
            unchecked = outcome.retired.length;
            withheld = searched.refused;
        }
    }

    const changed = outcome.changed + outcome.retired.length - unresolved - unchecked;
    const gone = outcome.gone + unresolved;
    const counts = {
        ...(changed > 0 && { changed }),
        ...(gone > 0 && { gone }),
        ...(unresolved > 0 && { merged: unresolved }),
        ...(unchecked > 0 && { unchecked }),
    };

    // The deletes stand (the user approved them), but a chat no longer theirs alone gets counts only: no deleted or current text.
    if (withheld !== undefined) {
        return { ...counts, deleted: [], ...(outcome.deleted.length > 0 && { deletedCount: outcome.deleted.length }), status: withheld };
    }

    const candidates = offered.slice(0, FORGET_MAX_CANDIDATES);
    let status: ForgetStatus = "nothing_found";

    if (outcome.deleted.length > 0) {
        status = "deleted";
    } else if (candidates.length > 0) {
        status = "needs_confirmation";
    } else if (unchecked > 0) {
        // Not "nothing matched": the lookup could not finish.
        status = "unavailable";
    }

    return { ...(candidates.length > 0 && { candidates }), ...counts, deleted: outcome.deleted, status };
};

/** Finds what the query describes, for the user to confirm, or deletes the memories they confirmed. */
export const forgetFor = async (ctx: ActionCtx, args: ForgetArgs): Promise<ForgetResult> => {
    const { memories, query, ...requested } = args;

    // A confirmed call: the approval was the user's, so the ids are deleted as checked in the write.
    if (memories !== undefined && memories.length > 0) {
        return await deleteConfirmed(ctx, requested, memories);
    }

    if (query === undefined || query.trim() === "") {
        return { deleted: [], status: "nothing_found" };
    }

    const searched = await search(ctx, requested, query);

    if ("refused" in searched) {
        return { deleted: [], status: searched.refused };
    }

    const candidates = forgetCandidates(searched.found);

    return candidates.length === 0 ? { deleted: [], status: "nothing_found" } : { candidates, deleted: [], status: "needs_confirmation" };
};

/** The `forget` tool's lookup and delete, run on the user's own shard. */
export const forgetMemories = internalAction
    .input({
        memories: v.optional(v.array(vCandidate)),
        promptMessageId: v.string(),
        query: v.optional(v.string()),
        replyKey: v.optional(v.string()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(
        v.object({
            candidates: v.optional(v.array(vCandidate)),
            changed: v.optional(v.number()),
            deleted: v.array(v.string()),
            deletedCount: v.optional(v.number()),
            gone: v.optional(v.number()),
            merged: v.optional(v.number()),
            status: vForgetStatus,
            unchecked: v.optional(v.number()),
        }),
    )
    .action(async ({ args, ctx }) => await forgetFor(ctx, args));
