/**
 * Embedder declared on the schema's Vectorize indexes.
 *
 * Lunora's `.vectorize()` keeps an index in sync on every write by calling this
 * on the source text. Embeddings must go through the LLM Gateway (they are
 * billed and usage-tracked), and the gateway is reachable only over its service
 * binding — `ctx.services.llmGateway`, which exists on ACTIONS only. This
 * function receives no `ctx`, and `.vectorize()` sync runs inline inside the
 * mutation, which may not do external I/O anyway.
 *
 * So rows are embedded from an action (see `chat/embeddings.ts`) using
 * `ctx.vectors.upsert(index, { id, input, embed: async () => vector })`, with
 * the vector computed through `createGatewayEmbeddingModel(gatewayFetch(ctx))`;
 * the declared index is present for the read path (`ctx.vectors.query`).
 *
 * Reaching this function is therefore a bug, and it throws rather than silently
 * writing a zero vector.
 */
export const embed = async (_input: string): Promise<ReadonlyArray<number>> => {
    throw new Error(
        "Schema-level embedding is not supported: embeddings go through the LLM gateway's service binding, which only an action's ctx carries. Embed in an action and pass `embed` to ctx.vectors.upsert.",
    );
};
