import { v } from "lunorash/server";

import { ownedStorageRefsInUrlFields } from "../lib/stored-url-fields";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { assert } from "../lib/error-helpers";
import { paginatedDocsOf } from "../lib/output-validators";
import { paginationOptionsValidator } from "../lib/validators";
import { withoutUndefined } from "../lib/patch";

const MAX_PAGE_SIZE = 100;

export const get = query.input({ executionId: v.id("workflowExecutions") }).query(async ({ args, ctx }) => {
    const identity = await getAuthUserIdentity(ctx);

    if (!identity) {
        return null;
    }

    const execution = await ctx.db.get(args.executionId);

    if (!execution || execution.userId !== identity.userId) {
        return null;
    }

    return execution;
});

export const listByProject = query
    .input({
        paginationOpts: v.optional(paginationOptionsValidator),
        projectId: v.id("projects"),
    })
    .output(paginatedDocsOf("workflowExecutions"))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return { continueCursor: "", isDone: true, page: [], pageStatus: null, splitCursor: null };
        }

        const project = await ctx.db.projects.findFirst({ where: { _id: args.projectId } });

        if (!project || project.userId !== identity.userId) {
            return { continueCursor: "", isDone: true, page: [], pageStatus: null, splitCursor: null };
        }

        const options = args.paginationOpts ?? { cursor: null, numItems: 50 };
        const clamped = { ...options, numItems: Math.min(options.numItems ?? 50, MAX_PAGE_SIZE) };
        const executions = await ctx.db
            .query("workflowExecutions")
            .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId))
            .order("desc")
            .paginate(clamped);

        return executions;
    });

export const listByUser = internalQuery
    .input({
        paginationOpts: v.optional(paginationOptionsValidator),
        userId: v.string(),
    })
    .output(paginatedDocsOf("workflowExecutions"))
    .query(async ({ args, ctx }) => {
        const options = args.paginationOpts ?? { cursor: null, numItems: 50 };
        const clamped = { ...options, numItems: Math.min(options.numItems ?? 50, MAX_PAGE_SIZE) };
        const executions = await ctx.db
            .query("workflowExecutions")
            .withIndex("by_user", (q) => q.eq("userId", args.userId))
            .order("desc")
            .paginate(clamped);

        return executions;
    });

export const create = internalMutation
    .input({
        projectId: v.id("projects"),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
        userId: v.string(),
        workflowSnapshot: v.optional(v.any()),
    })
    .mutation(async ({ args, ctx }): Promise<Doc<"workflowExecutions">> => {
        const insertedId = await ctx.db.insert("workflowExecutions", {
            projectId: args.projectId,
            status: args.status,
            userId: args.userId,
            workflowSnapshot: await ownedStorageRefsInUrlFields(ctx, args.userId, args.workflowSnapshot),
        });
        const executionId = insertedId as Id<"workflowExecutions">;

        const execution = await ctx.db.get(executionId);

        assert(execution, `Execution ${executionId} not found`);

        return execution;
    });

export const updateStatus = internalMutation
    .input({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        executionId: v.id("workflowExecutions"),
        startedAt: v.optional(v.number()),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
        totalUsage: v.optional(
            v.object({
                completionTokens: v.number(),
                promptTokens: v.number(),
                totalTokens: v.number(),
            }),
        ),
    })
    .mutation(async ({ args, ctx }): Promise<Doc<"workflowExecutions"> | null> => {
        const execution = await ctx.db.get(args.executionId);

        assert(execution, `Execution ${args.executionId} not found`);
        await ctx.db.patch(
            args.executionId,
            withoutUndefined({
                completedAt: args.completedAt,
                error: args.error,
                startedAt: args.startedAt ?? execution.startedAt,
                status: args.status,
                totalUsage: args.totalUsage ?? execution.totalUsage,
            }),
        );

        return await ctx.db.get(args.executionId);
    });

export const deleteExecution = internalMutation
    .input({ executionId: v.id("workflowExecutions") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const execution = await ctx.db.get(args.executionId);

        assert(execution, `Execution ${args.executionId} not found`);

        // Delete all node executions first
        const nodeExecs = await ctx.db
            .query("nodeExecutions")
            .withIndex("by_execution_and_node", (q) => q.eq("executionId", args.executionId))
            .collect();

        await Promise.all(nodeExecs.map((nodeExecution) => ctx.db.delete(nodeExecution._id)));

        // Delete the execution
        await ctx.db.delete(args.executionId);

        return null;
    });
