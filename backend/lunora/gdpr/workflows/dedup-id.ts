/**
 * The replay-dedup key of one `context.run` made inside a raw `context.step.do` callback.
 *
 * A raw step retries its callback in place, which the runner's positional id cannot see, so a write made
 * that way would apply once per attempt. The id is derived from the request, the step's name and (for a
 * batched step) the batch number, so it is the same on every redelivery and different for every call.
 */
export const stepDedupId = (requestId: string, step: string, batch?: number): string =>
    batch === undefined ? `${step}:${requestId}` : `${step}:${requestId}:${String(batch)}`;
