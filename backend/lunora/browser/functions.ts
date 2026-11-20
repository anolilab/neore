/**
 * Browser Session Management Functions
 *
 * Internal mutations for creating, updating, and querying browser sessions.
 * Phase 2 adds extension pairing and management functions.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
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

/**
 * The thread's one active browser session: the agent's actions and the live view both read this row, so a viewer
 * always watches the browser the agent drives. {@link createSession} never adds a second one; were there two, both
 * readers still agree on the oldest.
 */
export const activeThreadSession = async (db: QueryCtx["db"], threadId: Id<"threads">): Promise<Doc<"browserSessions"> | null> =>
    await db
        .query("browserSessions")
        .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
        .first();

export const getActiveSession = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(async ({ args: { threadId }, ctx }) => await activeThreadSession(ctx.db, threadId));

export const createSession = internalMutation
    .input({
        connectUrl: v.optional(v.string()),
        providerSessionId: v.optional(v.string()),
        source: v.optional(v.string()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .mutation(async ({ args: { connectUrl, providerSessionId, source, threadId, userId }, ctx }) => {
        const { now } = ctx;
        // Two first actions at once both found no row: the second gets the first's row, whose browser stays the
        // thread's. Its own result names another browser, so `logAction` keeps only its audit row.
        const existing = await activeThreadSession(ctx.db, threadId);

        if (existing) {
            return existing._id;
        }

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
            "browserSessions",
            sessionId,
            withoutUndefined({
                ...updates,
                lastActivityAt: ctx.now,
            }),
        );
    });

/** The holds still ahead of `now`, less one instance of `released` (an action's own hold, when it ends). */
const holdsAfter = (holds: ReadonlyArray<number> | undefined, now: number, released?: number): number[] | undefined => {
    const kept = (holds ?? []).filter((until) => until > now);
    const own = released === undefined ? -1 : kept.indexOf(released);

    if (own !== -1) {
        kept.splice(own, 1);
    }

    return kept.length > 0 ? kept : undefined;
};

/**
 * A browser action is about to run on this session's browser: it holds the browser until `until` (the renderer
 * call's deadline), so a slow action does not read as idle. Only for a browser that is still alive; a reaped one is
 * replaced by the renderer, and the row shows it again once {@link logAction} records the new one. Each action adds
 * its own hold beside those of actions still running.
 */
export const beginSessionUse = internalMutation
    .input({ sessionId: v.id("browserSessions"), until: v.number() })
    .mutation(async ({ args: { sessionId, until }, ctx }) => {
        const session = await ctx.db.get("browserSessions", sessionId);

        if (session) {
            await patchRow(ctx.db, "browserSessions", session, { inUseHolds: [...(holdsAfter(session.inUseHolds, ctx.now) ?? []), until] });
        }
    });

/**
 * The action failed: its own hold ends, and the row is back to its last confirmed activity. Nothing is stamped, and
 * the hold of another action still running stays.
 */
export const endSessionUse = internalMutation
    .input({ sessionId: v.id("browserSessions"), until: v.number() })
    .mutation(async ({ args: { sessionId, until }, ctx }) => {
        const session = await ctx.db.get("browserSessions", sessionId);

        if (session) {
            await patchRow(ctx.db, "browserSessions", session, { inUseHolds: holdsAfter(session.inUseHolds, ctx.now, until) });
        }
    });

export const logAction = internalMutation
    .input({
        action: v.string(),
        currentUrl: v.optional(v.string()),
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        /** The hold this action took with {@link beginSessionUse}, if it took one. */
        heldUntil: v.optional(v.number()),
        providerSessionId: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        /** The provider session id the row held when the action started (`null`: none), so a stale result is not written. */
        startedWithProviderSessionId: v.union(v.string(), v.null()),
        success: v.boolean(),
        target: v.optional(v.string()),
        value: v.optional(v.string()),
    })
    .mutation(
        async ({
            args: {
                action,
                currentUrl,
                durationMs,
                errorMessage,
                heldUntil,
                providerSessionId,
                sessionId,
                startedWithProviderSessionId,
                success,
                target,
                value,
            },
            ctx,
        }) => {
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

            const session = await ctx.db.get("browserSessions", sessionId);

            if (!session) {
                return;
            }

            const inUseHolds = holdsAfter(session.inUseHolds, ctx.now, heldUntil);

            // Another action moved the row to a newer browser while this one ran (it replaced the old browser, or the
            // renderer closed it): this result is about a browser the row no longer names. Only the audit row and the
            // end of its own hold are kept; its id, page and activity would bring the old browser back.
            if ((session.providerSessionId ?? null) !== startedWithProviderSessionId) {
                await patchRow(ctx.db, "browserSessions", session, { inUseHolds });

                return;
            }

            // A browser the renderer replaced (the old one expired, or was closed after a blocked redirect) starts with
            // no page of the old one: `currentUrl` is only what this action reported, or nothing.
            const replaced = providerSessionId !== undefined && providerSessionId !== session.providerSessionId;

            // Every action keeps the provider's browser alive for another idle window; the live view reads this to tell
            // a running browser from one the provider has reaped (`browser/live-view-logic.ts`). This action's hold ends;
            // the holds of actions still running stay.
            await patchRow(ctx.db, "browserSessions", session, {
                inUseHolds,
                lastActivityAt: ctx.now,
                ...(replaced ? { currentUrl, providerSessionId } : withoutUndefined({ currentUrl })),
            });
        },
    );

export const closeSession = internalMutation
    .input({
        errorMessage: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        status: v.optional(v.string()),
    })
    .mutation(async ({ args: { errorMessage, sessionId, status }, ctx }) => {
        await ctx.db.patch(
            "browserSessions",
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
        const { now } = ctx;
        const insertedId = await ctx.db.insert("browserExtensions", {
            extensionId: `ext_${now}_${ctx.newId()}`,
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
        await patchRow(ctx.db, "browserExtensions", extension, {
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
        const extension = await ctx.db.get("browserExtensions", extensionDocId);

        if (!extension || extension.userId !== userId) {
            return { success: false };
        }

        await ctx.db.patch("browserExtensions", extensionDocId, {
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
            await ctx.db.patch("browserExtensions", extension._id, {
                lastSeenAt: ctx.now,
            });
        }
    });
