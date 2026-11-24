/**
 * Vector encoding for the schema's Vectorize indexes.
 *
 * A vector row keeps its vector as an array and a text copy (`vectorText`, written by
 * `encodeVector`), because `.vectorize()` syncs the indexed column to Vectorize on every
 * write and only accepts a text source. The embedding itself is computed beforehand, in
 * an action, through the LLM Gateway (billed and usage-tracked; the gateway is reachable
 * only over its service binding, which an action's ctx carries). The writes then pass the
 * finished vector in, so the sync needs no model call.
 *
 * `embed` is the declared embedder: the sync calls it with the stored text and it
 * returns that vector. It throws on anything that is not a finite number array, so a
 * corrupt row fails the write rather than indexing a wrong vector.
 */
export const encodeVector = (vector: ReadonlyArray<number>): string => JSON.stringify(vector);

export const decodeVector = (text: string): number[] => {
    const parsed: unknown = JSON.parse(text);

    if (!Array.isArray(parsed) || parsed.some((value) => !(typeof value === "number" && Number.isFinite(value)))) {
        throw new Error("A stored vector must be a JSON array of finite numbers.");
    }

    return parsed;
};

export const embed = async (input: string): Promise<ReadonlyArray<number>> => decodeVector(input);
