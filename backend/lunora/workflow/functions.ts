import { LunoraError, v } from "lunorash/server";

import { ownedStorageRefsInUrlFields, signOwnedUrlFieldsForDisplay } from "../lib/stored-url-fields";
import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { vWorkflowContent } from "../agent/validators";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import { paginatedDocsOf } from "../lib/output-validators";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { throwForbidden, throwNotFound } from "../lib/error-helpers";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonValue } from "../lib/validators";

// Get a workflow project
export const getWorkflow = authQuery
    .input({
        projectId: v.id("projects"),
    })
    .query(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            return null;
        }

        // Check access
        if (project.userId !== userId) {
            return null;
        }

        // Ensure it's a workflow project
        if (project.projectType !== "workflow") {
            return null;
        }

        return { ...project, workflowContent: await signOwnedUrlFieldsForDisplay(context, project.userId, project.workflowContent) };
    });

// List all workflow projects for a user
export const listWorkflows = authQuery
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number().check((n) => Number.isSafeInteger(n) && n >= 1 && n <= 100, {
                message: "numItems must be an integer between 1 and 100",
                schema: { maximum: 100, minimum: 1, type: "integer" },
            }),
        }),
    })
    .query(async ({ args: { organizationId, paginationOpts }, ctx: context }) => {
        const { userId } = context.user;

        // Get all projects and filter for workflows
        const result = organizationId
            ? await context.runQuery(api.agent.projects.listProjects, {
                  organizationId,
                  paginationOpts,
              })
            : await context.runQuery(api.agent.projects.listProjects, {
                  paginationOpts,
                  userId,
              });

        // Filter for workflow type
        return {
            ...result,
            page: result.page.filter((p: any) => p.projectType === "workflow"),
        };
    });

// Create a new workflow project
export const createWorkflow = authMutation
    .use(rateLimit("projects/create"))
    .input({
        color: v.optional(v.string().max(MAX_LENGTH.short)),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        title: v.string().max(MAX_LENGTH.long),
        workflowContent: v.optional(vWorkflowContent),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;

        assertOwnOrganizationId(context.user, args.organizationId);

        const project = await context.runMutation(internal.agent.projects.createProject, {
            color: args.color,
            description: args.description,
            icon: args.icon ?? "workflow",
            organizationId: args.organizationId,
            projectType: "workflow",
            title: args.title,
            userId,
            // Signed storage URLs in node data are persisted as references
            // (`lib/stored-url-fields.ts`) and signed again on read — only
            // storage the caller owns; anything else is stripped.
            workflowContent: await ownedStorageRefsInUrlFields(
                context,
                userId,
                args.workflowContent ?? {
                    edges: [],
                    nodes: [],
                    viewport: { x: 0, y: 0, zoom: 1 },
                },
            ),
        });

        context.log.event("workflow.create_workflow", { projectId: project._id });

        return project._id;
    });

// Update workflow content
export const updateWorkflowContent = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
        workflowContent: vWorkflowContent,
    })
    .output(v.string())
    .mutation(async ({ args: { projectId, workflowContent }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot update another user's workflow");
        }

        if (project.projectType !== "workflow") {
            throw new LunoraError("BAD_REQUEST", "Project is not a workflow");
        }

        const updatedProject = await context.runMutation(internal.agent.projects.updateProject, {
            patch: {
                workflowContent: await ownedStorageRefsInUrlFields(context, userId, workflowContent),
            },
            projectId: projectId as Id<"projects">,
        });

        context.log.event("workflow.update_workflow_content", { projectId: updatedProject._id });

        return updatedProject._id;
    });

// Create a workflow execution
export const createExecution = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.string())
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot execute another user's workflow");
        }

        if (project.projectType !== "workflow") {
            throw new LunoraError("BAD_REQUEST", "Project is not a workflow");
        }

        // Create execution record
        const execution = await context.runMutation(internal.agent.workflow_executions.create, {
            projectId: projectId as Id<"projects">,
            status: "pending",
            userId,
            workflowSnapshot: project.workflowContent,
        });

        context.log.event("workflow.create_execution", { executionId: execution._id });

        return execution._id;
    });

// Get execution status
export const getExecution = authQuery
    .input({
        executionId: v.id("workflowExecutions"),
    })
    .query(async ({ args: { executionId }, ctx: context }) => {
        const { userId } = context.user;

        const execution = await context.runQuery(api.agent.workflow_executions.get, {
            executionId: executionId as Id<"workflowExecutions">,
        });

        if (!execution) {
            return null;
        }

        if (execution.userId !== userId) {
            return null;
        }

        return { ...execution, workflowSnapshot: await signOwnedUrlFieldsForDisplay(context, execution.userId, execution.workflowSnapshot) };
    });

// List executions for a workflow
export const listExecutions = authQuery
    .input({
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number().check((n) => Number.isSafeInteger(n) && n >= 1 && n <= 100, {
                message: "numItems must be an integer between 1 and 100",
                schema: { maximum: 100, minimum: 1, type: "integer" },
            }),
        }),
        projectId: v.id("projects"),
    })
    .output(paginatedDocsOf("workflowExecutions"))
    .query(async ({ args: { paginationOpts, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            throwNotFound("Workflow");
        }

        if (project.userId !== userId) {
            throwForbidden("Cannot access another user's workflow executions");
        }

        const executions = await context.runQuery(api.agent.workflow_executions.listByProject, {
            paginationOpts,
            projectId: projectId as Id<"projects">,
        });

        return {
            ...executions,
            page: await Promise.all(
                executions.page.map(async (execution) => {
                    return { ...execution, workflowSnapshot: await signOwnedUrlFieldsForDisplay(context, execution.userId, execution.workflowSnapshot) };
                }),
            ),
        };
    });

// Update execution status
export const updateExecutionStatus = authMutation
    .use(rateLimit("projects/update"))
    .input({
        error: v.optional(v.string().max(MAX_LENGTH.text)),
        executionId: v.id("workflowExecutions"),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { error, executionId, status }, ctx: context }) => {
        const { userId } = context.user;

        const execution = await context.runQuery(api.agent.workflow_executions.get, {
            executionId: executionId as Id<"workflowExecutions">,
        });

        if (!execution) {
            throwNotFound("Execution");
        }

        if (execution.userId !== userId) {
            throwForbidden("Cannot update another user's execution");
        }

        await context.runMutation(internal.agent.workflow_executions.updateStatus, {
            completedAt: ["cancelled", "completed", "failed"].includes(status) ? context.now : undefined,
            error,
            executionId: executionId as Id<"workflowExecutions">,
            startedAt: status === "running" ? context.now : undefined,
            status,
        });

        context.log.event("workflow.update_execution_status", { status });

        return { success: true };
    });

// Create node execution record
export const createNodeExecution = authMutation
    .use(rateLimit("projects/update"))
    .input({
        executionId: v.id("workflowExecutions"),
        input: v.optional(vJsonValue),
        nodeId: v.string().max(MAX_LENGTH.id),
        nodeType: v.string().max(MAX_LENGTH.short),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped")),
    })
    .output(v.string())
    .mutation(async ({ args: { executionId, input, nodeId, nodeType, status }, ctx: context }) => {
        assertJsonWithinLimit(input, "input");
        const { userId } = context.user;

        const execution = await context.runQuery(api.agent.workflow_executions.get, {
            executionId: executionId as Id<"workflowExecutions">,
        });

        if (!execution) {
            throwNotFound("Execution");
        }

        if (execution.userId !== userId) {
            throwForbidden("Cannot create node execution for another user's workflow");
        }

        const nodeExecution = await context.runMutation(internal.agent.node_executions.create, {
            executionId: executionId as Id<"workflowExecutions">,
            input,
            nodeId,
            nodeType,
            startedAt: status === "running" ? context.now : undefined,
            status,
        });

        context.log.event("workflow.create_node_execution", { nodeType, status });

        return nodeExecution._id;
    });

// Update node execution
export const updateNodeExecution = authMutation
    .use(rateLimit("projects/update"))
    .input({
        error: v.optional(v.string().max(MAX_LENGTH.text)),
        nodeExecutionId: v.string().max(MAX_LENGTH.id),
        output: v.optional(vJsonValue),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped")),
        usage: v.optional(v.object({ completionTokens: v.number(), promptTokens: v.number(), totalTokens: v.number() })),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { error, nodeExecutionId, output, status, usage }, ctx: context }) => {
        assertJsonWithinLimit(output, "output");
        const { userId } = context.user;

        const nodeExecution = await context.runQuery(internal.agent.node_executions.get, {
            nodeExecutionId: nodeExecutionId as Id<"nodeExecutions">,
        });

        if (!nodeExecution) {
            throwNotFound("Node execution");
        }

        // Verify through parent execution
        const execution = await context.runQuery(api.agent.workflow_executions.get, {
            executionId: nodeExecution.executionId,
        });

        if (!execution || execution.userId !== userId) {
            throwForbidden("Cannot update node execution for another user's workflow");
        }

        await context.runMutation(internal.agent.node_executions.update, {
            completedAt: ["completed", "failed", "skipped"].includes(status) ? context.now : undefined,
            error,
            nodeExecutionId: nodeExecutionId as Id<"nodeExecutions">,
            output,
            status,
            usage,
        });

        context.log.event("workflow.update_node_execution", { status });

        return { success: true };
    });

// Get node executions for an execution
export const listNodeExecutions = authQuery
    .input({
        executionId: v.id("workflowExecutions"),
    })
    .query(async ({ args: { executionId }, ctx: context }) => {
        const { userId } = context.user;

        const execution = await context.runQuery(api.agent.workflow_executions.get, {
            executionId: executionId as Id<"workflowExecutions">,
        });

        if (!execution) {
            return [];
        }

        if (execution.userId !== userId) {
            return [];
        }

        const nodeExecutions = await context.runQuery(internal.agent.node_executions.listByExecution, {
            executionId: executionId as Id<"workflowExecutions">,
        });

        // Outputs are persisted with storage references; sign them for display.
        return await Promise.all(
            nodeExecutions.map(async (nodeExecution) => {
                return {
                    ...nodeExecution,
                    input: await signOwnedUrlFieldsForDisplay(context, execution.userId, nodeExecution.input),
                    output: await signOwnedUrlFieldsForDisplay(context, execution.userId, nodeExecution.output),
                };
            }),
        );
    });
