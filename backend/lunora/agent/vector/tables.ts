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

// Cloudflare Vectorize accepts 32-1536 dimensions per index, so 1536 is the widest
// embedding the deploy can store. A wider model must be asked for fewer dimensions.
export const VectorDimensions = [128, 256, 512, 768, 1024, 1408, 1536] as const;

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

/** The dimensions in probe order: 1024 first (bge-m3, memory and knowledge), the usual one, so most lookups cost a single read. */
const PROBE_ORDER = [1024, ...VectorDimensions.filter((dimension) => dimension !== 1024)] as const;

/**
 * The `embeddings_*` table holding the row `id` and the row itself, or `null` when none does. An id carries
 * no table of its own (`db.normalizeId` only checks its shape), and `ctx.db` by-id calls take the table first,
 * so it is found by reading each dimension's table in turn. Callers that need the row take it from here
 * instead of reading it again.
 */
export const findVectorRow = async (
    db: { get: (table: never, id: never) => Promise<unknown> },
    id: string,
): Promise<{ row: Record<string, unknown>; table: VectorTableName } | null> => {
    for (const dimension of PROBE_ORDER) {
        const table = getVectorTableName(dimension);
        const row = await db.get(table as never, id as never);

        if (row !== null && row !== undefined) {
            return { row: row as Record<string, unknown>, table };
        }
    }

    return null;
};

/** The `embeddings_*` table holding the row `id`, or `null` when none does. */
export const findVectorTable = async (db: { get: (table: never, id: never) => Promise<unknown> }, id: string): Promise<VectorTableName | null> => {
    const found = await findVectorRow(db, id);

    return found?.table ?? null;
};

/** The table and dimension of vector row `id`, or `null` when no `embeddings_*` table holds it (already deleted). */
export const getVectorIdInfo = async (context: QueryContext, id: VectorTableId) => {
    const tableName = await findVectorTable(context.db, id);

    if (tableName === null) {
        return null;
    }

    return { dimension: Number(tableName.slice("embeddings_".length)) as VectorDimension, tableName };
};
