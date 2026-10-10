import { LunoraError, v } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { getMemberByOrganizationAndUser } from "../auth/lib/better-auth-queries";
import { requireOwnedThread } from "../agent/thread-read-access";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { throwForbidden } from "../lib/error-helpers";
import { MAX_LENGTH } from "../lib/validators";

export const getProject = authQuery
    .input({
        projectId: v.id("projects"),
    })
    .query(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Inline DB access - bypasses runQuery validator overhead
        const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

        if (!project) {
            return null;
        }

        // Check access: user must own the project or it must be in their organization
        if (project.userId && project.userId !== userId) {
            // Check if user has access via organization membership
            if (project.organizationId) {
                const member = await getMemberByOrganizationAndUser(context, project.organizationId, userId);

                if (!member) {
                    return null;
                }
                // User is a member of the organization, allow access
            } else {
                return null;
            }
        }

        return project;
    });

export const listProjects = authQuery
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
    })
    .query(async ({ args: { organizationId, paginationOpts }, ctx: context }) => {
        const { userId } = context.user;

        // Note: runQuery to agent component is necessary, but lightweight auth
        // saves 200-400ms on the auth check before entering this handler
        if (organizationId) {
            return await context.runQuery(api.agent.projects.listProjects, {
                organizationId,
                paginationOpts,
            });
        }

        return await context.runQuery(api.agent.projects.listProjects, {
            paginationOpts,
            userId,
        });
    });

export const listPinnedProjects = authQuery
    .input({
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .query(async ({ args: { organizationId }, ctx: context }) => {
        const { userId } = context.user;

        // Note: runQuery to agent component is necessary, but lightweight auth
        // saves 200-400ms on the auth check before entering this handler
        if (organizationId) {
            return await context.runQuery(api.agent.projects.listPinnedProjects, {
                organizationId,
            });
        }

        return await context.runQuery(api.agent.projects.listPinnedProjects, {
            userId,
        });
    });

export const createProject = authMutation
    .use(rateLimit("projects/create"))
    .input({
        color: v.optional(v.string().max(MAX_LENGTH.short)),
        context: v.optional(v.string().max(MAX_LENGTH.document)),
        defaultEnabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        defaultModel: v.optional(v.string().max(MAX_LENGTH.short)),
        defaultReasoningEffort: v.optional(v.number()),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        icon: v.optional(v.string().max(MAX_LENGTH.url)),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;

        assertOwnOrganizationId(context.user, args.organizationId);

        const project = await context.runMutation(internal.agent.projects.createProject, {
            ...args,
            userId,
        });

        context.log.event("projects.create_project", { hasOrganization: args.organizationId !== undefined, projectId: project._id });

        return project._id;
    });

export const updateProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        patch: v.object({
            color: v.optional(v.union(v.string().max(MAX_LENGTH.short), v.null())),
            context: v.optional(v.string().max(MAX_LENGTH.document)),
            defaultEnabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            defaultModel: v.optional(v.string().max(MAX_LENGTH.short)),
            defaultReasoningEffort: v.optional(v.number()),
            description: v.optional(v.string().max(MAX_LENGTH.long)),
            icon: v.optional(v.union(v.string().max(MAX_LENGTH.url), v.null())),
            organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
            title: v.optional(v.string().max(MAX_LENGTH.long)),
        }),
        projectId: v.id("projects"),
    })
    .output(v.string())
    .mutation(async ({ args: { patch, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot update another user's project");
        }

        assertOwnOrganizationId(context.user, patch.organizationId);

        const updatedProject = await context.runMutation(internal.agent.projects.updateProject, {
            patch: {
                ...patch,
                color: typeof patch.color === "string" ? patch.color : undefined,
                icon: typeof patch.icon === "string" ? patch.icon : undefined,
            },
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.update_project", { projectId, updatedFieldCount: Object.keys(patch).length });

        return updatedProject._id;
    });

export const deleteProject = authMutation
    .use(rateLimit("projects/delete"))
    .input({
        moveThreadsToProjectId: v.optional(v.string().max(MAX_LENGTH.id)),
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { moveThreadsToProjectId, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot delete another user's project");
        }

        // Threads may only be moved into another project of the caller's.
        if (moveThreadsToProjectId) {
            const target = await context.db.projects.findFirst({ where: { _id: context.db.asId("projects", moveThreadsToProjectId) } });

            if (!target || target.userId !== userId) {
                throw new LunoraError("NOT_FOUND", "Project not found");
            }
        }

        await context.runMutation(internal.agent.projects.deleteProject, {
            moveThreadsToProjectId: (moveThreadsToProjectId || undefined) as Id<"projects"> | undefined,
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.delete_project", { movedThreads: Boolean(moveThreadsToProjectId), projectId });

        return { success: true };
    });

export const pinProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot pin another user's project");
        }

        await context.runMutation(internal.agent.projects.pinProject, {
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.pin_project", { projectId });

        return { success: true };
    });

export const unpinProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.id("projects"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot unpin another user's project");
        }

        await context.runMutation(internal.agent.projects.unpinProject, {
            projectId: projectId as Id<"projects">,
        });

        context.log.event("projects.unpin_project", { projectId });

        return { success: true };
    });

export const moveThreadToProject = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectId: v.optional(v.id("projects")),
        threadId: v.id("threads"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectId, threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Fetch thread and project in parallel for better performance
        const [, project] = await Promise.all([
            requireOwnedThread(context, threadId as Id<"threads">, userId),
            projectId ? context.runQuery(api.agent.projects.getProject, { projectId: projectId as Id<"projects"> }) : Promise.resolve(null),
        ]);

        if (projectId) {
            // Verify project exists and user has access
            if (!project) {
                throw new LunoraError("NOT_FOUND", "Project not found");
            }

            if (project.userId && project.userId !== userId) {
                throwForbidden("Cannot move thread to another user's project");
            }

            await context.runMutation(internal.agent.threads.moveThreadToProject, {
                projectId: projectId as Id<"projects">,
                threadId: threadId as Id<"threads">,
            });
        } else {
            await context.runMutation(internal.agent.threads.removeThreadFromProject, {
                threadId: threadId as Id<"threads">,
            });
        }

        context.log.event("projects.move_thread_to_project", { projectId: projectId ?? null, threadId });

        return { success: true };
    });

export const listThreadsByProject = authQuery
    .input({
        paginationOpts: v.object({
            cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()),
            endCursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
            id: v.optional(v.number()),
            numItems: v.number(),
        }),
        projectId: v.id("projects"),
    })
    .query(async ({ args: { paginationOpts, projectId }, ctx: context }) => {
        const { userId } = context.user;

        // Verify project exists and user has access
        const project = await context.runQuery(api.agent.projects.getProject, {
            projectId: projectId as Id<"projects">,
        });

        if (!project) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        if (project.userId && project.userId !== userId) {
            throwForbidden("Cannot access another user's project");
        }

        return await context.runQuery(api.agent.projects.listThreadsByProject, {
            paginationOpts,
            projectId: projectId as Id<"projects">,
        });
    });

export const updateProjectOrder = authMutation
    .use(rateLimit("projects/update"))
    .input({
        projectOrders: v.array(v.object({ order: v.number(), projectId: v.string().max(MAX_LENGTH.id) })),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { projectOrders }, ctx: context }) => {
        const { userId } = context.user;

        // Batch verify all projects belong to the user first
        const projectVerificationPromises = projectOrders.map(({ projectId }) =>
            context.runQuery(api.agent.projects.getProject, { projectId: projectId as Id<"projects"> }),
        );
        const projects = await Promise.all(projectVerificationPromises);

        // Filter to only projects owned by the user and update them in parallel
        const updatePromises = projectOrders
            .map(({ order, projectId }, index) => {
                const project = projects[index];

                if (project && project.userId === userId) {
                    return context.runMutation(internal.agent.projects.updateProjectOrder, {
                        projectOrders: [{ order, projectId: projectId as Id<"projects"> }],
                    });
                }

                return null;
            })
            .filter((promise): promise is Promise<any> => promise !== null);

        await Promise.all(updatePromises);

        context.log.event("projects.update_project_order", { requestedCount: projectOrders.length, updatedCount: updatePromises.length });

        return { success: true };
    });
