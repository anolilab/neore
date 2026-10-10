import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";

/**
 * Vector table utilities and validators.
 * Migrated from `@neore/backend-agent` component.
 */
import { omit } from "../../lib/collections";

// Embedding fields definition
const embeddings = {
    model: v.string(),
    // `model|table|threadId` / `model|table|userId`: ONE string each, because a
    // Vectorize metadata filter matches a string, number or boolean — never an
    // array. See `vectorFilterKey`.
    model_table_threadId: v.optional(v.string()),
    // not set for private threads
    model_table_userId: v.optional(v.string()),
    // What table it's stored in. (usually messages or memories)
    table: v.string(),
    threadId: v.optional(v.string()),
    userId: v.optional(v.string()),
    vector: v.array(v.number()),
};

/** The field RECORD, so call sites can spread it into their own `v.object({...})`. */
export const vEmbeddingsWithoutDenormalizedFieldsFields = omit(embeddings, ["model_table_userId", "model_table_threadId"]);

export const vEmbeddingsWithoutDenormalizedFields = v.object(vEmbeddingsWithoutDenormalizedFieldsFields);
export type EmbeddingsWithoutDenormalizedFields = Infer<typeof vEmbeddingsWithoutDenormalizedFields>;

export const VectorDimensions = [128, 256, 512, 768, 1024, 1408, 1536, 2048, 3072, 4096] as const;

export function validateVectorDimension(dimension: number): asserts dimension is VectorDimension {
    if (!VectorDimensions.includes(dimension as VectorDimension)) {
        throw new Error(`Unsupported vector dimension ${dimension}. Supported: ${VectorDimensions.join(", ")}`);
    }
}

export type VectorDimension = (typeof VectorDimensions)[number];
export const VectorTableNames = VectorDimensions.map((d) => `embeddings_${d}`) as `embeddings_${(typeof VectorDimensions)[number]}`[];
export type VectorTableName = (typeof VectorTableNames)[number];
export type VectorTableId = Id<(typeof VectorTableNames)[number]>;

export const vVectorDimension = v.union(...VectorDimensions.map((dimension) => v.literal(dimension)));
export const vVectorTableName = v.union(...VectorTableNames.map((name) => v.literal(name)));
export const vVectorId = v.union(...VectorTableNames.map((name) => v.id(name)));

export const getVectorTableName = (dimension: VectorDimension) => `embeddings_${dimension}` as VectorTableName;

/**
 * The Vectorize index a dimension's table is synced to.
 *
 * Hyphenated, not underscored: the table is `embeddings_1024` and the index the
 * schema declares via `.vectorize("vector", { index: … })` is `embeddings-1024`,
 * because Cloudflare index names cannot contain underscores.
 */
export const getVectorIndexName = (dimension: VectorDimension) => `embeddings-${dimension}`;

export const getVectorIdInfo = (context: QueryContext, id: VectorTableId) => {
    for (const dimension of VectorDimensions) {
        const tableName = getVectorTableName(dimension);

        if (context.db.normalizeId(tableName, id)) {
            return { dimension, tableName };
        }
    }

    throw new Error(`Unknown vector table id: ${id}`);
};
