/**
 * Palette search by meaning (plan C6): the sync that keeps a thread's title and
 * summary vectors current, and the query the palette calls. The rules live in
 * `thread-search-plan.ts`; the triggers that start a sync are in
 * `thread-search-triggers.ts`.
 *
 * The sync is an action because embedding is an external call: it reads the
 * thread, embeds through the gateway, inserts the vectors, then commits them in a
 * mutation. A commit that finds its text already changed deletes its own vectors.
 */
import { type Infer, LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { type ActionCtx, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { authAction, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { gatewayFetch } from "../lib/services";
import { MAX_LENGTH } from "../lib/validators";
import { deleteVectorRow } from "./table-writes";
import {
    bestMeaningThreadIds,
    claimHolds,
    decideCommit,
    type EmbeddedVector,
    embedInput,
    hasEnoughTurns,
    isSearchEligible,
    MEANING_MIN_CHARS,
    MEANING_MIN_SCORE,
    MEANING_RESULT_LIMIT,
    MEANING_TOP_K,
    planThreadSearch,
    SEARCH_CLAIM_MS,
    SEARCH_DIMENSION,
    SEARCH_KINDS,
    SEARCH_MODEL,
    SEARCH_TABLE,
    SEARCH_VECTOR_FIELD,
    type SearchKind,
    type SearchPlan,
} from "./thread-search-plan";
import { findVectorRow, type VectorDimension, type VectorTableName } from "./vector/tables";
import { searchVectors } from "./vector";

// Validators shared by the sync and the palette query.
const vSearchKind = v.union(v.literal("title"), v.literal("summary"));
const vSlot = v.object({ text: v.union(v.string(), v.null()), vectorId: v.union(v.string(), v.null()) });

/** What a sync reads: the thread's eligibility, its stored texts and vectors, and whether it has enough turns. */
const vSearchState = v.union(
    v.null(),
    v.object({
        eligible: v.boolean(),
        enoughTurns: v.boolean(),
        summary: vSlot,
        title: vSlot,
        userId: v.string(),
    }),
);

const nullable = <T>(value: T | undefined): T | null => value ?? null;
const defined = (value: string | null): string | undefined => value ?? undefined;

export const readThreadSearchState = internalQuery
    .input({ threadId: v.id("threads") })
    .output(vSearchState)
    .query(async ({ args, ctx }) => {
        const thread = (await ctx.db.get("threads", args.threadId)) as Doc<"threads"> | null;

        if (!thread || thread.userId === undefined) {
            return null;
        }

        return {
            eligible: isSearchEligible(thread),
            // The count the messages triggers keep on the thread (`agent/thread-search-triggers.ts`): no message scan.
            enoughTurns: hasEnoughTurns(thread.userTurnCount ?? 0),
            summary: { text: nullable(thread.summary), vectorId: nullable(thread.summaryVectorId) },
            title: { text: nullable(thread.title), vectorId: nullable(thread.titleVectorId) },
            userId: thread.userId,
        };
    });

/** Whether the owner's model rules allow the embedding model. */
const embeddingAllowedFor = async (ctx: ActionCtx, userId: string): Promise<boolean> => {
    const { embeddingModelAllowed } = await import("../chat/lib/gateway-embedding-model");

    return embeddingModelAllowed(await loadModelFilterRules(ctx, userId));
};

/** Embeds the texts through the gateway, billed to the thread's owner. `[]` when the owner's model rules refuse the model. */
const embedTexts = async (ctx: ActionCtx, userId: string, texts: string[]): Promise<number[][]> => {
    const { createGatewayEmbeddingModel, embeddingModelAllowed } = await import("../chat/lib/gateway-embedding-model");
    const modelFilterRules = await loadModelFilterRules(ctx, userId);

    if (!embeddingModelAllowed(modelFilterRules)) {
        return [];
    }

    const { embedMany } = await import("./client/search");
    const { embeddings } = await embedMany(ctx, {
        embeddingModel: createGatewayEmbeddingModel(gatewayFetch(ctx), { modelFilterRules, userId }),
        threadId: undefined,
        userId,
        values: texts,
    });

    return embeddings;
};

/**
 * The texts still worth sending to the gateway. The plan was made from a read that a lock
 * or an edit may have overtaken, so this reads again right before the send: a thread no
 * longer wanted, or text that has moved, sends nothing. The window that remains is this
 * read's latency; the commit still decides what is kept.
 */
const textsStillWanted = async <T extends { kind: SearchKind; text: string }>(
    ctx: ActionCtx,
    threadId: Id<"threads">,
    state: NonNullable<Infer<typeof vSearchState>>,
    texts: T[],
): Promise<T[]> => {
    const fresh = await ctx.runQuery(internal.agent.thread_search.readThreadSearchState, { threadId });

    if (fresh === null || !fresh.eligible || !fresh.enoughTurns) {
        return [];
    }

    return texts.filter((entry) => fresh[entry.kind].text === state[entry.kind].text);
};

/**
 * Embeds the planned texts, inserts their vectors and commits them. A failed embed leaves the
 * stored vectors as they are and throws. A failure after a vector was written removes the
 * vectors written so far: the thread row does not point at them yet.
 */
const embedAndCommit = async (
    ctx: ActionCtx,
    threadId: Id<"threads">,
    userId: string,
    plan: SearchPlan,
    texts: { kind: SearchKind; text: string }[],
): Promise<void> => {
    let vectors: number[][] = [];

    if (texts.length > 0) {
        try {
            vectors = await embedTexts(
                ctx,
                userId,
                texts.map((entry) => entry.text),
            );
        } catch (error) {
            console.warn("[agent/thread-search] Embedding failed; the scheduler retries the sync:", error);

            throw error;
        }
    }

    const embedded: EmbeddedVector[] = [];

    try {
        for (const [index, entry] of texts.entries()) {
            const vector = vectors[index];

            if (!vector) {
                continue;
            }

            if (vector.length !== SEARCH_DIMENSION) {
                console.warn(`[agent/thread-search] Expected ${String(SEARCH_DIMENSION)} dimensions, got ${String(vector.length)}; skipped`);

                continue;
            }

            const ids = await ctx.runMutation(internal.agent.vector.insertBatch, {
                vectorDimension: SEARCH_DIMENSION as VectorDimension,
                vectors: [
                    {
                        messageId: undefined,
                        model: SEARCH_MODEL,
                        table: SEARCH_TABLE[entry.kind],
                        threadId,
                        userId,
                        vector,
                    },
                ],
            });

            for (const vectorId of ids) {
                embedded.push({ kind: entry.kind, text: entry.text, vectorId: vectorId as string });
            }
        }

        if (embedded.length === 0 && plan.clear.length === 0) {
            return;
        }

        await ctx.runMutation(internal.agent.thread_search.commitThreadSearch, {
            clear: plan.clear,
            embedded,
            threadId,
        });
    } catch (error) {
        if (embedded.length > 0) {
            await ctx.runMutation(internal.agent.vector.deleteBatch, { ids: embedded.map((vector) => vector.vectorId) });
        }

        throw error;
    }
};

/**
 * One sync of a thread's vectors: plan from the state, embed what is wanted,
 * commit. A failed embed leaves the stored vectors as they are and throws, so the
 * scheduler retries the sync (`SYNC_RETRY` in `thread-search-triggers.ts`).
 */
export const runThreadSearchSync = async (ctx: ActionCtx, args: { changed: SearchKind[]; threadId: Id<"threads"> }): Promise<void> => {
    const state = await ctx.runQuery(internal.agent.thread_search.readThreadSearchState, { threadId: args.threadId });

    if (!state) {
        return;
    }

    const slots = {
        summary: { text: embedInput(state.summary.text), vectorId: defined(state.summary.vectorId) },
        title: { text: embedInput(state.title.text), vectorId: defined(state.title.vectorId) },
    };
    const plan: SearchPlan = planThreadSearch({ eligible: state.eligible, slots }, args.changed, state.enoughTurns);

    if (plan.embed.length === 0 && plan.clear.length === 0) {
        return;
    }

    let texts = plan.embed.flatMap((kind) => {
        const { text } = slots[kind];

        return text === undefined ? [] : [{ kind, text }];
    });

    // A model the owner's rules refuse embeds nothing. Checked here, before the gateway and the
    // commit, and recorded on the thread so the replies re-sync it at most daily (`searchKindsChanged`).
    if (texts.length > 0 && !(await embeddingAllowedFor(ctx, state.userId))) {
        await ctx.runMutation(internal.agent.thread_search.markThreadSearchRefused, { threadId: args.threadId });

        texts = [];
    }

    if (texts.length > 0) {
        texts = await textsStillWanted(ctx, args.threadId, state, texts);
    }

    // One job embeds a thread's texts at a time. A job that finds them already claimed has nothing to add: the holder commits them.
    const claimId = texts.length > 0 ? crypto.randomUUID() : undefined;

    if (claimId !== undefined && !(await ctx.runMutation(internal.agent.thread_search.claimThreadSearch, { claimId, texts, threadId: args.threadId }))) {
        // The holder embeds these texts and commits them. Its plan may not clear what this one does, so clear that here too.
        if (plan.clear.length > 0) {
            await ctx.runMutation(internal.agent.thread_search.commitThreadSearch, { clear: plan.clear, embedded: [], threadId: args.threadId });
        }

        return;
    }

    try {
        await embedAndCommit(ctx, args.threadId, state.userId, plan, texts);
    } finally {
        if (claimId !== undefined) {
            await ctx.runMutation(internal.agent.thread_search.releaseThreadSearch, { claimId, threadId: args.threadId });
        }
    }
};

export const syncThreadSearch = internalAction.input({ changed: v.array(vSearchKind), threadId: v.id("threads") }).action(async ({ args, ctx }) => {
    await runThreadSearchSync(ctx, { changed: args.changed, threadId: args.threadId });
});

/** Records that the owner's model rules refused the embedding model for this thread, for the replies' daily recheck. */
export const markThreadSearchRefused = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = (await ctx.db.get("threads", args.threadId)) as Doc<"threads"> | null;

        if (thread) {
            await patchRow(ctx.db, "threads", thread, { searchRefusedAt: Date.now() });
        }

        return null;
    });

const vClaimTexts = v.array(v.object({ kind: vSearchKind, text: v.string() }));

/**
 * Takes the claim on a thread's texts before the gateway call. `false` when a live claim already
 * covers these texts (another job embeds them now), or when the thread is gone.
 */
export const claimThreadSearch = internalMutation
    .input({ claimId: v.string(), texts: vClaimTexts, threadId: v.id("threads") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = (await ctx.db.get("threads", args.threadId)) as Doc<"threads"> | null;
        const now = Date.now();

        if (!thread || claimHolds(thread.searchClaim, args.texts, now)) {
            return false;
        }

        await patchRow(ctx.db, "threads", thread, { searchClaim: { expiresAt: now + SEARCH_CLAIM_MS, id: args.claimId, texts: args.texts } });

        return true;
    });

/** Releases the claim this job took, if it still holds it. Another job's claim is left as it is. */
export const releaseThreadSearch = internalMutation
    .input({ claimId: v.string(), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = (await ctx.db.get("threads", args.threadId)) as Doc<"threads"> | null;

        if (thread?.searchClaim?.id === args.claimId) {
            // Removed, not kept as expired: a kept claim would hold a copy of the thread's text on the row.
            await patchRow(ctx.db, "threads", thread, { searchClaim: undefined });
        }

        return null;
    });

export const commitThreadSearch = internalMutation
    .input({
        clear: v.array(v.object({ kind: vSearchKind, vectorId: v.string() })),
        embedded: v.array(v.object({ kind: vSearchKind, text: v.string(), vectorId: v.string() })),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = (await ctx.db.get("threads", args.threadId)) as Doc<"threads"> | null;
        // A thread that is gone, no longer eligible, or below the turn gate keeps none of what was embedded for it. The gate is read
        // here, in the commit, so a job that finished embedding before a turn was deleted cannot restore vectors after that delete's check.
        const keep = thread && isSearchEligible(thread) && hasEnoughTurns(thread.userTurnCount ?? 0) ? args.embedded : [];
        const decision = decideCommit(
            {
                summary: { text: thread?.summary, vectorId: thread?.summaryVectorId },
                title: { text: thread?.title, vectorId: thread?.titleVectorId },
            },
            keep,
            args.clear,
        );

        if (thread) {
            const changes: Record<string, string | undefined> = {};

            for (const kind of SEARCH_KINDS) {
                if (kind in decision.set) {
                    changes[SEARCH_VECTOR_FIELD[kind]] = decision.set[kind];
                }
            }

            if (Object.keys(changes).length > 0) {
                await patchRow(ctx.db, "threads", thread, changes);
            }
        }

        const rejected = args.embedded.map((vector) => vector.vectorId).filter((id) => !decision.accepted.includes(id));

        for (const id of [...decision.replaced, ...rejected]) {
            await deleteVectorRow(ctx.db, id as Id<VectorTableName>);
        }

        return null;
    });

/** Deletes vectors whose thread is gone (scheduled by the threads' delete trigger). */
export const deleteThreadVectors = internalMutation
    .input({ vectorIds: v.array(v.string()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (const id of args.vectorIds) {
            await deleteVectorRow(ctx.db, id as Id<VectorTableName>);
        }

        return null;
    });

/** The thread each vector belongs to, for the vector ids a search returned. A vector row gone since is `null`. */
export const threadIdsForVectors = internalQuery
    .input({ vectorIds: v.array(v.string()) })
    .output(v.array(v.object({ threadId: v.union(v.string(), v.null()), vectorId: v.string() })))
    .query(async ({ args, ctx }) => {
        const found: { threadId: string | null; vectorId: string }[] = [];

        for (const vectorId of args.vectorIds) {
            const row = await findVectorRow(ctx.db as never, vectorId);

            found.push({ threadId: typeof row?.row.threadId === "string" ? row.row.threadId : null, vectorId });
        }

        return found;
    });

/**
 * The visible rows of the given threads, for the owner. A thread that is deleted,
 * temporary, locked, not theirs or back below the turn gate is dropped, whatever a
 * stale vector says: its cleanup may still be queued.
 */
export const visibleThreadsForSearch = internalQuery
    .input({ threadIds: v.array(v.string()), userId: v.string() })
    .output(v.array(v.object({ archived: v.boolean(), threadId: v.string(), title: v.union(v.string(), v.null()) })))
    .query(async ({ args, ctx }) => {
        const rows: { archived: boolean; threadId: string; title: string | null }[] = [];

        for (const threadId of args.threadIds) {
            const thread = (await ctx.db.get("threads", threadId as Id<"threads">)) as Doc<"threads"> | null;

            if (!thread || thread.userId !== args.userId || !isSearchEligible(thread) || !hasEnoughTurns(thread.userTurnCount ?? 0)) {
                continue;
            }

            rows.push({ archived: thread.status === "archived", threadId, title: nullable(thread.title) });
        }

        return rows;
    });

export interface MeaningThread {
    archived: boolean;
    score: number;
    threadId: string;
    title: string | null;
}

/**
 * The palette's meaning search for one person: embed the query, read the nearest
 * title and summary vectors among their own, map each to its thread and keep the
 * best ones. Returns `[]` for a query too short to embed, or when the model is
 * refused for the person.
 */
export const searchThreadsByMeaningFor = async (ctx: ActionCtx, args: { query: string; userId: string }): Promise<MeaningThread[]> => {
    const query = args.query.trim();

    if (query.length < MEANING_MIN_CHARS) {
        return [];
    }

    let queryVector: number[] | undefined;

    try {
        [queryVector] = await embedTexts(ctx, args.userId, [query.slice(0, 2000)]);
    } catch (error) {
        console.warn("[agent/thread-search] Query embedding failed; the palette shows title matches only:", error);

        return [];
    }

    if (!queryVector || queryVector.length !== SEARCH_DIMENSION) {
        return [];
    }

    const hits: { _id: string; _score: number }[] = [];

    for (const kind of SEARCH_KINDS) {
        const matches = await searchVectors(ctx, queryVector, {
            dimension: SEARCH_DIMENSION as VectorDimension,
            limit: MEANING_TOP_K,
            model: SEARCH_MODEL,
            searchAllMessagesForUserId: args.userId,
            table: SEARCH_TABLE[kind],
        });

        hits.push(
            ...matches.map((match) => {
                return { _id: match._id as string, _score: match._score };
            }),
        );
    }

    if (hits.length === 0) {
        return [];
    }

    const owners = await ctx.runQuery(internal.agent.thread_search.threadIdsForVectors, { vectorIds: hits.map((hit) => hit._id) });
    const threadByVector = new Map(owners.flatMap((owner) => (owner.threadId === null ? [] : [[owner.vectorId, owner.threadId] as const])));
    // Every candidate is kept until visibility is checked: a stale hit (a locked or deleted thread) must not take a result slot.
    const ranked = bestMeaningThreadIds(
        hits.flatMap((hit) => {
            const threadId = threadByVector.get(hit._id);

            return threadId === undefined ? [] : [{ score: hit._score, threadId }];
        }),
        MEANING_MIN_SCORE,
        MEANING_TOP_K * SEARCH_KINDS.length,
    );

    if (ranked.length === 0) {
        return [];
    }

    const rows = await ctx.runQuery(internal.agent.thread_search.visibleThreadsForSearch, {
        threadIds: ranked.map((entry) => entry.threadId),
        userId: args.userId,
    });
    const scoreOf = new Map(ranked.map((entry) => [entry.threadId, entry.score] as const));

    return rows
        .map((row) => {
            return { archived: row.archived, score: scoreOf.get(row.threadId) ?? 0, threadId: row.threadId, title: row.title };
        })
        .toSorted((a, b) => b.score - a.score)
        .slice(0, MEANING_RESULT_LIMIT);
};

export const searchThreadsByMeaning = authAction
    .use(rateLimit("threads/meaning"))
    .input({ query: v.string().max(MAX_LENGTH.long) })
    .output(v.array(v.object({ archived: v.boolean(), score: v.number(), threadId: v.string(), title: v.union(v.string(), v.null()) })))
    .action(async ({ args, ctx }) => {
        if (args.query.trim().length > 2000) {
            throw new LunoraError("BAD_REQUEST", "Query must be at most 2000 characters");
        }

        return await searchThreadsByMeaningFor(ctx, { query: args.query, userId: ctx.user.userId });
    });
