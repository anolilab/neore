/**
 * Sandbox Session Management Functions
 *
 * Internal mutations for creating, updating, and querying sandbox sessions.
 * Follows the browserSessions pattern from browser/functions.ts.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { withoutUndefined } from "../lib/patch";

export const getActiveSession = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(
        async ({ args: { threadId }, ctx }) =>
            await ctx.db
                .query("sandboxSessions")
                .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
                .first(),
    );

export const createSession = internalMutation
    .input({
        sandboxId: v.optional(v.string()),
        templateId: v.optional(v.string()),
        threadId: v.id("threads"),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
    })
    .mutation(async ({ args: { sandboxId, templateId, threadId, timeoutMs, userId }, ctx }) => {
        const now = ctx.now;
        const insertedId = await ctx.db.insert("sandboxSessions", {
            lastActivityAt: now,
            sandboxId,
            startedAt: now,
            status: "starting",
            templateId,
            threadId,
            timeoutMs: timeoutMs ?? 300_000,
            userId,
        });

        return insertedId as Id<"sandboxSessions">;
    });

export const updateSession = internalMutation
    .input({
        cleanupFnId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        sandboxId: v.optional(v.string()),
        sessionId: v.id("sandboxSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { sessionId, ...updates }, ctx }) => {
        const patch: Partial<Doc<"sandboxSessions">> = {
            lastActivityAt: ctx.now,
        };

        if (updates.status !== undefined) patch.status = updates.status;

        if (updates.sandboxId !== undefined) patch.sandboxId = updates.sandboxId;

        if (updates.errorMessage !== undefined) patch.errorMessage = updates.errorMessage;

        if (updates.completedAt !== undefined) patch.completedAt = updates.completedAt;

        if (updates.cleanupFnId !== undefined) patch.cleanupFnId = updates.cleanupFnId;

        await ctx.db.patch(sessionId, withoutUndefined(patch));
    });

export const logAction = internalMutation
    .input({
        action: v.string(),
        command: v.optional(v.string()),
        durationMs: v.optional(v.number()),
        exitCode: v.optional(v.number()),
        sessionId: v.id("sandboxSessions"),
        stderr: v.optional(v.string()),
        stdout: v.optional(v.string()),
        success: v.boolean(),
    })
    .mutation(async ({ args: { action, command, durationMs, exitCode, sessionId, stderr, stdout, success }, ctx }) => {
        await ctx.db.insert("sandboxActions", {
            action,
            command,
            durationMs,
            exitCode,
            sessionId,
            stderr: stderr?.slice(0, 50_000),
            stdout: stdout?.slice(0, 50_000), // Truncate large outputs
            success: success ? 1 : 0,
            timestamp: ctx.now,
        });
    });

export const closeSession = internalMutation
    .input({
        errorMessage: v.optional(v.string()),
        sessionId: v.id("sandboxSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { errorMessage, sessionId, status }, ctx }) => {
        await ctx.db.patch(
            sessionId,
            withoutUndefined({
                completedAt: ctx.now,
                errorMessage,
                lastActivityAt: ctx.now,
                status: status ?? "completed",
            }),
        );
    });

export const checkAndTerminateIdle = internalMutation
    .input({
        sessionId: v.id("sandboxSessions"),
    })
    .mutation(async ({ args: { sessionId }, ctx }) => {
        const session = await ctx.db.get(sessionId);

        if (!session || session.status !== "active") {
            return { shouldTerminate: false };
        }

        const idleMs = ctx.now - session.lastActivityAt;
        const timeoutMs = session.timeoutMs ?? 300_000;

        if (idleMs >= timeoutMs) {
            await ctx.db.patch(sessionId, {
                completedAt: ctx.now,
                lastActivityAt: ctx.now,
                status: "terminated",
            });

            return { sandboxId: session.sandboxId, shouldTerminate: true };
        }

        return { shouldTerminate: false };
    });
