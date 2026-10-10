/**
 * Browser Session Management Functions
 *
 * Internal mutations for creating, updating, and querying browser sessions.
 * Phase 2 adds extension pairing and management functions.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { encryptKey } from "../lib/encryption";
import { patchRow, withoutUndefined } from "../lib/patch";
// ── Utility ─────────────────────────────────────────────────────────────

/** Generate a cryptographically random 8-character uppercase pairing code. */
const generatePairingCode = (): string => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    const randomBytes = new Uint8Array(8);

    crypto.getRandomValues(randomBytes);
    let code = "";

    for (let i = 0; i < 8; i += 1) {
        code += chars[randomBytes[i]! % chars.length];
    }

    return code;
};

export const getActiveSession = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(
        async ({ args: { threadId }, ctx }) =>
            await ctx.db
                .query("browserSessions")
                .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
                .first(),
    );

export const createSession = internalMutation
    .input({
        connectUrl: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        source: v.optional(v.string()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { connectUrl, providerSessionId, source, threadId, userId }, ctx }) => {
        const now = ctx.now;

        // Encrypt the CDP connect URL before persisting — it contains session credentials
        const encryptedConnectUrl = connectUrl ? await encryptKey(connectUrl, "tool-keys") : undefined;
        const insertedId = await ctx.db.insert("browserSessions", {
            connectUrl: encryptedConnectUrl,
            lastActivityAt: now,
            providerSessionId,
            source: source ?? "browserbase",
            startedAt: now,
            status: "active",
            threadId,
            userId,
        });

        return insertedId as Id<"browserSessions">;
    });

export const updateSession = internalMutation
    .input({
        completedAt: v.optional(v.number()),
        currentUrl: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { sessionId, ...updates }, ctx }) => {
        await ctx.db.patch(
            sessionId,
            withoutUndefined({
                ...updates,
                lastActivityAt: ctx.now,
            }),
        );
    });

export const logAction = internalMutation
    .input({
        action: v.string(),
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        success: v.boolean(),
        target: v.optional(v.string()),
        value: v.optional(v.string()),
    })
    .mutation(async ({ args: { action, durationMs, errorMessage, sessionId, success, target, value }, ctx }) => {
        await ctx.db.insert("browserActions", {
            action,
            durationMs,
            errorMessage,
            sessionId,
            success: success ? 1 : 0,
            target,
            timestamp: ctx.now,
            value,
        });
    });

export const closeSession = internalMutation
    .input({
        errorMessage: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
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

// ── Browser Extension Functions (Phase 2) ───────────────────────────────

export const createExtensionPairing = internalMutation
    .input({
        userId: v.string(),
    })
    .mutation(async ({ args: { userId }, ctx }) => {
        const code = generatePairingCode();
        const now = ctx.now;
        const insertedId = await ctx.db.insert("browserExtensions", {
            extensionId: `ext_${now}_${crypto.randomUUID().slice(0, 8)}`,
            pairingCode: code,
            status: "pending",
            userId,
        });

        return { id: insertedId as Id<"browserExtensions">, pairingCode: code };
    });

export const completePairing = internalMutation
    .input({
        browserInfo: v.optional(v.string()),
        capabilities: v.optional(v.array(v.string())),
        extensionId: v.string(),
        extensionVersion: v.optional(v.string()),
        pairingCode: v.string(),
    })
    .mutation(async ({ args: { browserInfo, capabilities, extensionId, extensionVersion, pairingCode }, ctx }) => {
        const extension = await ctx.db
            .query("browserExtensions")
            .withIndex("by_pairingCode", (q) => q.eq("pairingCode", pairingCode))
            .first();

        if (!extension || extension.status !== "pending") {
            return { error: "Invalid or expired pairing code", success: false };
        }

        // `undefined` removes a field here: the one-time code in particular.
        await patchRow(ctx.db, extension, {
            browserInfo,
            capabilities,
            extensionId,
            extensionVersion,
            lastSeenAt: ctx.now,
            pairedAt: ctx.now,
            pairingCode: undefined, // Clear the one-time code
            status: "paired",
        });

        return { success: true, userId: extension.userId };
    });

export const getUserExtensions = internalQuery
    .input({
        userId: v.string(),
    })
    .query(
        async ({ args: { userId }, ctx }) =>
            await ctx.db
                .query("browserExtensions")
                .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "paired"))
                .collect(),
    );

export const revokeExtension = internalMutation
    .input({
        extensionDocId: v.id("browserExtensions"),
        userId: v.string(),
    })
    .mutation(async ({ args: { extensionDocId, userId }, ctx }) => {
        const extension = await ctx.db.get(extensionDocId);

        if (!extension || extension.userId !== userId) {
            return { success: false };
        }

        await ctx.db.patch(extensionDocId, {
            status: "revoked",
        });

        return { success: true };
    });

export const extensionHeartbeat = internalMutation
    .input({
        extensionId: v.string(),
    })
    .mutation(async ({ args: { extensionId }, ctx }) => {
        const extension = await ctx.db
            .query("browserExtensions")
            .withIndex("by_extensionId", (q) => q.eq("extensionId", extensionId))
            .first();

        if (extension && extension.status === "paired") {
            await ctx.db.patch(extension._id, {
                lastSeenAt: ctx.now,
            });
        }
    });
