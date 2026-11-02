/**
 * The replay-dedup key of one `context.run` made inside a raw `context.step.do` callback.
 *
 * A raw step retries its callback in place, which the runner's positional id cannot see, so a write made
 * that way would apply once per attempt. The id is derived from the workflow INSTANCE (its scope), the step's name and (for a
 * batched step) the batch number, so it is the same on every retry within an instance, different for every call, and different in a fresh instance of the same request.
 */
export const stepDedupId = (scope: string, step: string, batch?: number): string =>
    batch === undefined ? `${step}:${scope}` : `${step}:${scope}:${String(batch)}`;
