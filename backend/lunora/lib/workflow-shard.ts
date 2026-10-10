/**
 * A durable workflow's function runner, bound to one user's shard.
 *
 * A workflow step's `context.run` dispatches through the Worker to the
 * DEFAULT shard (`__root__`) unless it names one, and a user's rows live on
 * their own (docs/plans/per-user-sharding.md). Every workflow here works on one
 * user's data, so the handler rebinds its context once and every step inherits
 * the shard.
 */
import type { WorkflowRunFunction } from "@lunora/workflow";

export const onUserShard = <C extends { run: WorkflowRunFunction }>(context: C, shardKey: string): C => {
    const run: WorkflowRunFunction = async (reference, args, options) => await context.run(reference, args, { ...options, shardKey });

    return { ...context, run };
};
