/**
 * Vector operations for embeddings.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { type ActionCtx as ActionContext, internalMutation, internalQuery, type MutationCtx as MutationContext } from "../../_generated/server";
import { mergedStream, stream } from "../../lib/streams";
import {
    type EmbeddingsWithoutDenormalizedFields,
    getVectorIndexName,
    getVectorTableName,
    type VectorDimension,
    type VectorTableId,
    vVectorDimension,
    vVectorId,
} from "./tables";

// Internal: it pages EVERY user's embedding ids with no identity at all, and
// nothing calls it. As a bare `query` it was reachable unauthenticated.
export const paginate = internalQuery
    .input({
        cursor: v.optional(v.string()),
        limit: v.number(),
        table: v.optional(v.string()),
        targetModel: v.string(),
        vectorDimension: vVectorDimension,
    })
    .output(
        v.from(
            v.object({
                continueCursor: v.union(v.string(), v.null()),
                ids: v.array(vVectorId),
                isDone: v.boolean(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const tableName = getVectorTableName(args.vectorDimension);
        const vectors = await ctx.db
            .query(tableName)
            .withIndex("model_table_threadId" as any, (q: any) =>
                args.table ? (q.eq("model", args.targetModel) as any).eq("table", args.table) : q.eq("model", args.targetModel),
            )
            .paginate({
                cursor: args.cursor ?? null,
                numItems: args.limit,
            });

        return {
            continueCursor: vectors.continueCursor,
            ids: vectors.page.map((vector) => vector._id),
            isDone: vectors.isDone,
        };
    });

export const deleteBatchForThread = internalMutation
    .input({
        cursor: v.optional(v.string()),
        limit: v.number(),
        model: v.string(),
        threadId: v.string(),
        vectorDimension: vVectorDimension,
    })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const tableName = getVectorTableName(args.vectorDimension);
        const vectors = await mergedStream<{ _id: Id<"embeddings_1536"> }>(
            ["thread", "memory"].map((table) =>
                stream(ctx.db)
                    .query(tableName)
                    .withIndex("model_table_threadId", (q: any) => q.eq("model", args.model).eq("table", table).eq("threadId", args.threadId)),
            ),
            ["threadId"],
        ).paginate({
            cursor: args.cursor ?? null,
            numItems: args.limit,
        });

        await Promise.all(vectors.page.map((vector) => ctx.db.delete(vector._id)));

        return {
            continueCursor: vectors.continueCursor,
            isDone: vectors.isDone,
        };
    });

export const insertBatch = internalMutation
    .input({
        vectorDimension: vVectorDimension,
        // Spelled out, not `...vEmbeddingsWithoutDenormalizedFieldsFields`. Lunora's
        // codegen resolves a spread of an object literal or a `const` holding one
        // (since anolilab/lunora#651), but this one is a runtime `omit(…)` call, so
        // there is nothing to resolve even in principle. The generated reference
        // carried ONLY `messageId`, which is why every caller's `{ model, table,
        // userId, vector }` was rejected as an unknown property.
        vectors: v.array(
            v.object({
                messageId: v.optional(v.id("messages")),
                model: v.string(),
                table: v.string(),
                threadId: v.optional(v.string()),
                userId: v.optional(v.string()),
                vector: v.array(v.number()),
            }),
        ),
    })
    .output(v.from(v.array(vVectorId)))
    .mutation(async ({ args, ctx }) =>
        Promise.all(
            args.vectors.map(async ({ messageId, ...vector }) => {
                const embeddingId = await insertVector(ctx, args.vectorDimension, vector);

                if (messageId) {
                    await ctx.db.patch(messageId, { embeddingId });
                }

                return embeddingId;
            }),
        ),
    );

/** The metadata value `searchVectors` filters on — one string, the only kind of value a Vectorize filter can match. */
export const vectorFilterKey = (model: string, table: string, scope: string): string => `${model}|${table}|${scope}`;

export const insertVector = async (context: MutationContext, dimension: VectorDimension, innerV: EmbeddingsWithoutDenormalizedFields) =>
    context.db.insert(getVectorTableName(dimension), {
        ...innerV,
        model_table_threadId: innerV.threadId ? vectorFilterKey(innerV.model, innerV.table, innerV.threadId) : undefined,
        model_table_userId: innerV.userId ? vectorFilterKey(innerV.model, innerV.table, innerV.userId) : undefined,
    });

export const searchVectors = async (
    context: ActionContext,
    vector: number[],
    args: {
        dimension: VectorDimension;
        limit?: number;
        model: string;
        searchAllMessagesForUserId?: string;
        table: string;
        threadId?: Id<"threads">;
        userId?: string;
    },
) => {
    // The previous runtime kept the vector index ON the table and searched it with a query
    // builder. Lunora syncs the column to a Vectorize index (declared in
    // `schema.ts` via `.vectorize(...)`) and searches it through `ctx.vectors`,
    // whose filter is a plain equality object rather than a builder.
    const matches = await context.vectors.query(getVectorIndexName(args.dimension) as Parameters<typeof context.vectors.query>[0], {
        filter: args.searchAllMessagesForUserId
            ? { model_table_userId: vectorFilterKey(args.model, args.table, args.searchAllMessagesForUserId) }
            : { model_table_threadId: vectorFilterKey(args.model, args.table, args.threadId!) },
        topK: args.limit,
        vector,
    });

    return matches.matches.map((match) => {
        return { _id: match.id as VectorTableId, _score: match.score };
    });
};

export const updateBatch = internalMutation
    .input({
        vectors: v.array(
            v.object({
                id: vVectorId,
                model: v.string(),
                vector: v.array(v.number()),
            }),
        ),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await Promise.all(
            args.vectors.map((embedding) =>
                ctx.db.patch(embedding.id, {
                    model: embedding.model,
                    vector: embedding.vector,
                }),
            ),
        );

        return null;
    });

export const deleteBatch = internalMutation
    .input({
        ids: v.array(vVectorId),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await Promise.all(args.ids.map((id) => ctx.db.delete(id)));

        return null;
    });
