/**
 * Sandbox Session Management Functions
 *
 * Internal mutations for creating, updating, and querying sandbox sessions.
 * Follows the browserSessions pattern from browser/functions.ts.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
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
        const { now } = ctx;
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

        if (idleMs < timeoutMs) {
            // Not idle yet: the cleanup action checks again once the idle window has run out.
            return { recheckInMs: timeoutMs - idleMs, shouldTerminate: false };
        }

        // A bot's computer keeps its filesystem and memory: it is paused, not killed,
        // and the next call resumes it (`sandbox-node.ts#getOrCreateBotComputer`).
        const pause = session.botId !== undefined;

        await ctx.db.patch(
            sessionId,
            pause ? { lastActivityAt: ctx.now, status: "paused" } : { completedAt: ctx.now, lastActivityAt: ctx.now, status: "terminated" },
        );

        return { pause, sandboxId: session.sandboxId, shouldTerminate: true };
    });

/** A `starting` claim older than this was abandoned mid-create, so the next caller may take over. */
const STALE_STARTING_MS = 2 * 60_000;

/**
 * Find-or-create a bot's computer in ONE mutation, so two chats or routines
 * cannot each create one. The loser sees the winner's row (`created: false`).
 */
export const claimBotComputer = internalMutation
    .input({
        botId: v.id("bots"),
        timeoutMs: v.number(),
        userId: v.string(),
    })
    .output(
        v.object({
            created: v.boolean(),
            sandboxId: v.optional(v.string()),
            sessionId: v.id("sandboxSessions"),
            status: v.string(),
        }),
    )
    .mutation(async ({ args: { botId, timeoutMs, userId }, ctx }) => {
        for (const status of ["active", "paused"] as const) {
            const live = await ctx.db
                .query("sandboxSessions")
                .withIndex("by_botId_status", (q) => q.eq("botId", botId).eq("status", status))
                .first();

            if (live) {
                return { created: false, sandboxId: live.sandboxId, sessionId: live._id, status };
            }
        }

        const starting = await ctx.db
            .query("sandboxSessions")
            .withIndex("by_botId_status", (q) => q.eq("botId", botId).eq("status", "starting"))
            .first();

        if (starting && ctx.now - starting.startedAt < STALE_STARTING_MS) {
            return { created: false, sessionId: starting._id, status: "starting" };
        }

        if (starting) {
            await ctx.db.patch(starting._id, { completedAt: ctx.now, errorMessage: "Abandoned while starting", status: "failed" });
        }

        const sessionId = await ctx.db.insert("sandboxSessions", {
            botId,
            lastActivityAt: ctx.now,
            startedAt: ctx.now,
            status: "starting",
            timeoutMs,
            userId,
        });

        return { created: true, sessionId, status: "starting" };
    });

/**
 * Retire every computer a bot owns, for bot deletion: mark each session
 * terminated and schedule its sandbox kill (the kill needs an action).
 */
/**
 * Retire every computer a bot owns: mark each session terminated and schedule its sandbox kill
 * (the kill needs an action). Shared by bot deletion and account erasure, so an erased bot's
 * computer is destroyed, not left running.
 */
export const retireBotComputersIn = async (ctx: MutationCtx, botId: Id<"bots">): Promise<void> => {
    for (const status of ["active", "paused", "starting"] as const) {
        const sessions = await ctx.db
            .query("sandboxSessions")
            .withIndex("by_botId_status", (q) => q.eq("botId", botId).eq("status", status))
            .take(50);

        for (const session of sessions) {
            await ctx.db.patch(session._id, { completedAt: ctx.now, lastActivityAt: ctx.now, status: "terminated" });

            if (session.sandboxId) {
                await ctx.scheduler.runAfter(0, internal.sandbox.cleanup.killSandboxById, { sandboxId: session.sandboxId });
            }
        }
    }
};

export const retireBotComputers = internalMutation
    .input({ botId: v.id("bots") })
    .output(v.null())
    .mutation(async ({ args: { botId }, ctx }) => {
        await retireBotComputersIn(ctx, botId);

        return null;
    });

/**
 * Marks a bot's computer active once its sandbox exists or has resumed. Accepts only a session
 * still holding that claim: `starting`, `paused`, or already active on the same sandbox. Any
 * other state means it was replaced or retired meanwhile, and the caller must kill its sandbox.
 */
export const activateBotComputer = internalMutation
    .input({ sandboxId: v.string(), sessionId: v.id("sandboxSessions") })
    .output(v.boolean())
    .mutation(async ({ args: { sandboxId, sessionId }, ctx }) => {
        const session = await ctx.db.get(sessionId);

        if (!session) {
            return false;
        }

        const stillOurs = session.status === "starting" || session.status === "paused" || (session.status === "active" && session.sandboxId === sandboxId);

        if (!stillOurs) {
            return false;
        }

        await ctx.db.patch(sessionId, { lastActivityAt: ctx.now, sandboxId, status: "active" });

        return true;
    });
