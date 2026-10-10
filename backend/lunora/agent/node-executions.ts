import { v } from "lunorash/server";

import { ownedStorageRefsInUrlFields } from "../lib/stored-url-fields";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { assert } from "../lib/error-helpers";
import { withoutUndefined } from "../lib/patch";

export const get = internalQuery.input({ nodeExecutionId: v.id("nodeExecutions") }).query(async ({ args, ctx }) => await ctx.db.get(args.nodeExecutionId));

export const listByExecution = internalQuery.input({ executionId: v.id("workflowExecutions") }).query(async ({ args, ctx }) => {
    const nodeExecutions = await ctx.db
        .query("nodeExecutions")
        .withIndex("by_execution_and_node", (q) => q.eq("executionId", args.executionId))
        .collect();

    return nodeExecutions;
});

export const getByNode = internalQuery
    .input({
        executionId: v.id("workflowExecutions"),
        nodeId: v.string(),
    })
    .query(async ({ args, ctx }) => {
        const nodeExecution = await ctx.db
            .query("nodeExecutions")
            .withIndex("by_execution_and_node", (q) => q.eq("executionId", args.executionId).eq("nodeId", args.nodeId))
            .first();

        return nodeExecution;
    });

export const create = internalMutation
    .input({
        executionId: v.id("workflowExecutions"),
        input: v.optional(v.any()),
        nodeId: v.string(),
        nodeType: v.string(),
        startedAt: v.optional(v.number()),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped")),
    })
    .mutation(async ({ args, ctx }) => {
        const execution = await ctx.db.get(args.executionId);

        assert(execution, `Execution ${args.executionId} not found`);

        const insertedId = await ctx.db.insert("nodeExecutions", {
            executionId: args.executionId,
            // Signed storage URLs are persisted as references, and only storage
            // the workflow's owner owns (`lib/stored-url-fields.ts`) — the input
            // is client-supplied through `workflow_functions.createNodeExecution`.
            input: await ownedStorageRefsInUrlFields(ctx, execution.userId, args.input),
            nodeId: args.nodeId,
            nodeType: args.nodeType,
            startedAt: args.startedAt,
            status: args.status,
        });
        const nodeExecutionId = insertedId as Id<"nodeExecutions">;

        const nodeExecution = await ctx.db.get(nodeExecutionId);

        assert(nodeExecution, `Node execution ${nodeExecutionId} not found`);

        return nodeExecution;
    });

export const update = internalMutation
    .input({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        nodeExecutionId: v.id("nodeExecutions"),
        output: v.optional(v.any()),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped")),
        usage: v.optional(
            v.object({
                completionTokens: v.number(),
                promptTokens: v.number(),
                totalTokens: v.number(),
            }),
        ),
    })
    .mutation(async ({ args, ctx }) => {
        const nodeExecution = await ctx.db.get(args.nodeExecutionId);

        assert(nodeExecution, `Node execution ${args.nodeExecutionId} not found`);

        const execution = await ctx.db.get(nodeExecution.executionId);

        assert(execution, `Execution ${nodeExecution.executionId} not found`);
        await ctx.db.patch(
            args.nodeExecutionId,
            withoutUndefined({
                completedAt: args.completedAt,
                error: args.error,
                // The executor keeps passing the live signed URL between nodes; the
                // stored row keeps the key, signed again on read.
                output: await ownedStorageRefsInUrlFields(ctx, execution.userId, args.output),
                status: args.status,
                usage: args.usage,
            }),
        );

        return await ctx.db.get(args.nodeExecutionId);
    });

export const deleteByExecution = internalMutation
    .input({ executionId: v.id("workflowExecutions") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const nodeExecs = await ctx.db
            .query("nodeExecutions")
            .withIndex("by_execution_and_node", (q) => q.eq("executionId", args.executionId))
            .collect();

        await Promise.all(nodeExecs.map((nodeExecution) => ctx.db.delete(nodeExecution._id)));

        return null;
    });
