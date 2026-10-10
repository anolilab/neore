import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, type QueryCtx } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { ownedStorageRefsInUrlFields, signOwnedUrlFieldsForDisplay } from "../lib/stored-url-fields";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonObject } from "../lib/validators";

/**
 * The caller may use this workflow's room and history. Owner-only, the same
 * rule `workflow_functions.getWorkflow` applies — none of these procedures
 * checked it, so any signed-in user could watch another user's cursors, read
 * every saved version of their graph, and write versions into it.
 */
const requireWorkflowAccess = async (context: Pick<QueryCtx, "db">, projectId: string, userId: string): Promise<void> => {
    const project = await context.db.projects.findFirst({ where: { _id: projectId as Id<"projects"> } });

    if (!project || project.userId !== userId || project.projectType !== "workflow") {
        throw new LunoraError("NOT_FOUND", "Workflow not found");
    }
};

// Heartbeat interval and stale threshold
const STALE_THRESHOLD_MS = 15_000; // Consider user offline after 15s without heartbeat
const MAX_PRESENCE_PER_PROJECT = 20; // Max concurrent users per workflow

// Predefined user colors for presence indicators
const USER_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6", "#6366f1", "#d946ef"];

/**
 * Send a heartbeat to maintain presence in a workflow room.
 * Creates the presence record if it doesn't exist.
 */
export const heartbeat = authMutation
    .use(rateLimit("workflow/presence"))
    .input({
        cursorPosition: v.optional(v.union(v.object({ x: v.number(), y: v.number() }), v.null())),
        editingNodeId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
        projectId: v.id("projects"),
        selectedNodeId: v.optional(v.union(v.string().max(MAX_LENGTH.id), v.null())),
        sessionId: v.string().max(MAX_LENGTH.id),
        viewportCenter: v.optional(v.union(v.object({ x: v.number(), y: v.number(), zoom: v.number() }), v.null())),
    })
    .output(v.object({ status: v.union(v.literal("created"), v.literal("updated")) }))
    .mutation(async ({ args: { cursorPosition, editingNodeId, projectId, selectedNodeId, sessionId, viewportCenter }, ctx: context }) => {
        const { name, userId } = context.user;

        await requireWorkflowAccess(context, projectId, userId);

        const now = context.now;

        // Check if presence record already exists for this session
        const existing = await context.db
            .query("workflowPresence")
            .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
            .first();

        // A session id is the caller's to keep alive, not anyone's who learns it.
        if (existing && existing.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Not your presence session");
        }

        if (existing) {
            // `null` from the client means "deselected": `patchRow` removes the field
            // for an `undefined` value, which a plain patch would refuse.
            await patchRow(context.db, existing, {
                lastHeartbeat: now,
                ...(cursorPosition !== undefined && { cursorPosition }),
                ...(viewportCenter !== undefined && { viewportCenter }),
                ...(selectedNodeId !== undefined && { selectedNodeId: selectedNodeId ?? undefined }),
                ...(editingNodeId !== undefined && { editingNodeId: editingNodeId ?? undefined }),
            });

            context.log.event("workflow.heartbeat", { status: "updated" });

            return { status: "updated" as const };
        }

        // Assign a color based on existing users in the room
        const existingUsers = await context.db
            .query("workflowPresence")
            .withIndex("by_project_and_user", (q) => q.eq("projectId", projectId as Id<"projects">))
            .collect();

        const activeUsers = existingUsers.filter((u) => now - u.lastHeartbeat < STALE_THRESHOLD_MS);

        if (activeUsers.length >= MAX_PRESENCE_PER_PROJECT) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Too many concurrent users in this workflow");
        }

        const usedColors = new Set(activeUsers.map((u) => u.userColor));
        const availableColor = USER_COLORS.find((c) => !usedColors.has(c)) ?? USER_COLORS[activeUsers.length % USER_COLORS.length];

        await context.db.insert("workflowPresence", {
            cursorPosition: cursorPosition ?? null,
            editingNodeId: editingNodeId ?? undefined,
            lastHeartbeat: now,
            projectId: projectId as Id<"projects">,
            selectedNodeId: selectedNodeId ?? undefined,
            sessionId,
            userColor: availableColor,
            userId,
            userName: name ?? "Anonymous",
            viewportCenter: viewportCenter ?? null,
        });

        context.log.event("workflow.heartbeat", { status: "created" });

        return { status: "created" as const };
    });

/**
 * Disconnect from a workflow room.
 */
export const disconnect = authMutation
    .use(rateLimit("workflow/presence"))
    .input({
        sessionId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args: { sessionId }, ctx: context }) => {
        const existing = await context.db
            .query("workflowPresence")
            .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
            .first();

        if (existing && existing.userId === context.user.userId) {
            await context.db.delete(existing._id);
        }

        context.log.event("workflow.disconnect", { removed: existing !== null && existing.userId === context.user.userId });
    });

/**
 * List all active users in a workflow room.
 * Returns only users with recent heartbeats.
 */
export const listPresence = authQuery
    .input({
        projectId: v.id("projects"),
    })
    .output(
        v.array(
            v.object({
                cursorPosition: v.union(v.object({ x: v.number(), y: v.number() }), v.null()),
                editingNodeId: v.optional(v.string()),
                lastHeartbeat: v.number(),
                selectedNodeId: v.optional(v.string()),
                sessionId: v.string(),
                userColor: v.string(),
                userId: v.string(),
                userName: v.string(),
            }),
        ),
    )
    .query(async ({ args: { projectId }, ctx: context }) => {
        await requireWorkflowAccess(context, projectId, context.user.userId);

        const now = context.now;

        const allPresence = await context.db
            .query("workflowPresence")
            .withIndex("by_project_and_user", (q) => q.eq("projectId", projectId as Id<"projects">))
            .collect();

        // Filter to only active users
        const activePresence = allPresence.filter((p) => now - p.lastHeartbeat < STALE_THRESHOLD_MS);

        return activePresence.map((p) => {
            return {
                // `?? null`: the column is optional, the output declares
                // `v.union(v.object(…), v.null())`, and "no cursor" is null there.
                cursorPosition: p.cursorPosition ?? null,
                editingNodeId: p.editingNodeId ?? undefined,
                lastHeartbeat: p.lastHeartbeat,
                selectedNodeId: p.selectedNodeId ?? undefined,
                sessionId: p.sessionId,
                userColor: p.userColor,
                userId: p.userId,
                userName: p.userName,
            };
        });
    });

/**
 * Check if a node is locked by another user for editing.
 */
export const checkNodeLock = authQuery
    .input({
        nodeId: v.string().max(MAX_LENGTH.id),
        projectId: v.id("projects"),
    })
    .output(v.object({ locked: v.boolean(), lockedBy: v.union(v.string(), v.null()), lockerColor: v.union(v.string(), v.null()) }))
    .query(async ({ args: { nodeId, projectId }, ctx: context }) => {
        const { userId } = context.user;

        await requireWorkflowAccess(context, projectId, userId);

        const now = context.now;

        const allPresence = await context.db
            .query("workflowPresence")
            .withIndex("by_project_and_user", (q) => q.eq("projectId", projectId as Id<"projects">))
            .collect();

        const locker = allPresence.find((p) => p.editingNodeId === nodeId && p.userId !== userId && now - p.lastHeartbeat < STALE_THRESHOLD_MS);

        if (locker) {
            return {
                locked: true as const,
                lockedBy: locker.userName,
                lockerColor: locker.userColor,
            };
        }

        return { locked: false as const, lockedBy: null, lockerColor: null };
    });

export const cleanupStalePresence = internalMutation
    .input({})
    .output(v.object({ cleaned: v.number() }))
    .mutation(async ({ ctx: context }) => {
        const threshold = context.now - STALE_THRESHOLD_MS;

        const staleRecords = await context.db
            .query("workflowPresence")
            .withIndex("by_heartbeat")
            .filter((document) => document.lastHeartbeat < threshold)
            .collect();

        await Promise.all(staleRecords.map((record) => context.db.delete(record._id)));

        return { cleaned: staleRecords.length };
    });

/**
 * Save a version snapshot of the workflow.
 */
export const saveVersion = authMutation
    .use(rateLimit("workflow/save"))
    .input({
        content: v.object({
            edges: v.array(vJsonObject),
            nodes: v.array(vJsonObject),
            viewport: v.optional(v.object({ x: v.number(), y: v.number(), zoom: v.number() })),
        }),
        label: v.optional(v.string().max(MAX_LENGTH.short)),
        projectId: v.id("projects"),
    })
    .output(v.object({ versionId: v.string() }))
    .mutation(async ({ args: { content, label, projectId }, ctx: context }) => {
        assertJsonWithinLimit(content, "content");
        const { userId } = context.user;

        await requireWorkflowAccess(context, projectId, userId);

        const inserted = await context.db.insert("workflowVersions", {
            // Storage URLs in node data are kept as references — only storage the
            // caller owns (`lib/stored-url-fields.ts`).
            content: await ownedStorageRefsInUrlFields(context, userId, content),
            label,
            projectId: projectId as Id<"projects">,
            userId,
        });

        // `db.insert` returns the branded id STRING, not a row and not an array.
        // The `Array.isArray(...)` narrowing produced an `any` branch, which is the
        // only reason `.id` compiled — at runtime it reads `.id` off a string and
        // gets `undefined`.
        //
        // Here it then called `.toString()` on that `undefined`, so `saveVersion`
        // threw `TypeError: Cannot read properties of undefined` on EVERY call.
        context.log.event("workflow.save_version", { hasLabel: label !== undefined });

        return { versionId: inserted };
    });

/**
 * List version history for a workflow.
 */
export const listVersions = authQuery
    .input({
        limit: v.optional(v.number()),
        projectId: v.id("projects"),
    })
    .output(
        v.array(
            v.object({
                createdAt: v.number(),
                edgeCount: v.number(),
                id: v.string(),
                label: v.optional(v.string()),
                nodeCount: v.number(),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { limit, projectId }, ctx: context }) => {
        await requireWorkflowAccess(context, projectId, context.user.userId);

        const versions = await context.db
            .query("workflowVersions")
            .withIndex("by_project", (q) => q.eq("projectId", projectId as Id<"projects">))
            .order("desc")
            .take(limit ?? 50);

        return versions.map((vector) => {
            return {
                createdAt: vector._creationTime,
                edgeCount: Array.isArray(vector.content?.edges) ? vector.content.edges.length : 0,
                id: vector._id.toString(),
                label: vector.label ?? undefined,
                nodeCount: Array.isArray(vector.content?.nodes) ? vector.content.nodes.length : 0,
                userId: vector.userId,
            };
        });
    });

/**
 * Restore a workflow version.
 */
export const restoreVersion = authQuery
    .input({
        versionId: v.string().max(MAX_LENGTH.id),
    })
    .query(async ({ args: { versionId }, ctx: context }) => {
        const version = await context.db.get(versionId as Id<"workflowVersions">);

        if (!version) {
            return null;
        }

        await requireWorkflowAccess(context, version.projectId, context.user.userId);

        return await signOwnedUrlFieldsForDisplay(context, context.user.userId, version.content);
    });
