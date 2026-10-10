/**
 * Per-Agent Knowledge Base Assignment
 *
 * Allows assigning specific knowledge base files to individual agents/projects.
 * When an agent runs, only its assigned KB files are searched — enabling
 * domain-specific agents with focused, relevant context.
 *
 * Schema uses the existing `threadKnowledge` pattern extended to projects.
 * - Thread-level: files attached to specific threads (existing)
 * - Project-level: files assigned to all threads in a project (new)
 *
 * The retrieval pipeline checks project-level assignments as a fallback
 * when no thread-specific files are found.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
// ============================================================================
// Internal Queries
// ============================================================================

export const getProjectKnowledgeFileIds = internalQuery.input({ projectId: v.id("projects") }).query(async ({ args: { projectId }, ctx }) => {
    const links = await ctx.db
        .query("projectKnowledge")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .collect();

    return links.map((l) => l.knowledgeFileId as string);
});

export const resolveKnowledgeFiles = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .query(async ({ args: { threadId, userId }, ctx }) => {
        // 1. Check thread-specific files
        const threadLinks = await ctx.db
            .query("threadKnowledge")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect();

        if (threadLinks.length > 0) {
            return {
                fileIds: threadLinks.map((l) => l.knowledgeFileId as string),
                source: "thread" as const,
            };
        }

        // 2. Fallback to all user files
        const allFiles = await ctx.db
            .query("knowledgeFiles")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "indexed"))
            .collect();

        return {
            fileIds: allFiles.map((f) => f._id as string),
            source: "all" as const,
        };
    });

// ============================================================================
// Public cRPC Functions
// ============================================================================

/**
 * Assign a knowledge file to a project.
 */
export const assignToProject = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
        projectId: v.id("projects"),
    })
    .mutation(async ({ args: input, ctx }) => {
        const projectId = input.projectId as Id<"projects">;
        const knowledgeFileId = input.knowledgeFileId as Id<"knowledgeFiles">;

        // Verify ownership
        const file = await ctx.db.get(knowledgeFileId);

        if (!file || file.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Knowledge file not found");
        }

        const project = await ctx.db.projects.findFirst({ where: { _id: projectId } });

        if (!project || project.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        // Check if already assigned
        const existing = await ctx.db
            .query("projectKnowledge")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        if (existing.some((l) => (l.knowledgeFileId as string) === (knowledgeFileId as string))) {
            return { alreadyAssigned: true };
        }

        await ctx.db.insert("projectKnowledge", {
            assignedAt: ctx.now,
            knowledgeFileId,
            projectId,
        });

        ctx.log.event("knowledge.assign_to_project", { assigned: true });

        return { success: true };
    });

/**
 * Unassign a knowledge file from a project.
 */
export const unassignFromProject = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
        projectId: v.id("projects"),
    })
    .mutation(async ({ args: input, ctx }) => {
        const projectId = input.projectId as Id<"projects">;
        const knowledgeFileId = input.knowledgeFileId as Id<"knowledgeFiles">;

        // Verify ownership
        const project = await ctx.db.projects.findFirst({ where: { _id: projectId } });

        if (!project || project.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        const links = await ctx.db
            .query("projectKnowledge")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        const link = links.find((l) => (l.knowledgeFileId as string) === (knowledgeFileId as string));

        if (link) {
            await ctx.db.delete(link._id);
        }

        ctx.log.event("knowledge.unassign_from_project", { removed: Boolean(link) });

        return { success: true };
    });

/**
 * Get knowledge files assigned to a project.
 */
export const getProjectKnowledge = authQuery
    .input({
        projectId: v.id("projects"),
    })
    .query(async ({ args: input, ctx }) => {
        const projectId = input.projectId as Id<"projects">;

        // Verify ownership
        const project = await ctx.db.projects.findFirst({ where: { _id: projectId } });

        if (!project || project.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Project not found");
        }

        const links = await ctx.db
            .query("projectKnowledge")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        const files = await Promise.all(
            links.map(async (link) => {
                const file = await ctx.db.get(link.knowledgeFileId);

                if (!file) {
                    return null;
                }

                return {
                    ...file,
                    assignedAt: link.assignedAt,
                };
            }),
        );

        return files.filter(Boolean);
    });
