/**
 * Who else has a page open, and whether they are typing — a SOFT lock.
 *
 * The workflow-presence pattern (`workflow/presence.ts`): each open editor
 * heartbeats a row keyed by its `sessionId`; a row older than
 * {@link STALE_THRESHOLD_MS} is ignored and swept by the next heartbeat on that
 * page. Nothing is refused while someone else is editing — the editor shows
 * "X is editing" and the last save wins.
 */
import { v } from "lunorash/server";

import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { requirePageAccess } from "./access";
import { MAX_LENGTH } from "../lib/validators";

export const STALE_THRESHOLD_MS = 30_000;
const SESSION_ID_MAX = 64;
const MAX_PRESENCE_ROWS = 50;

const USER_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

export const heartbeatPagePresence = authMutation
    .use(rateLimit("pages/presence"))
    .input({ isEditing: v.boolean(), pageId: v.id("pages"), sessionId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { name, userId } = ctx.user;

        await requirePageAccess(ctx, args.pageId, userId, "read");

        const sessionId = args.sessionId.slice(0, SESSION_ID_MAX);
        const now = ctx.now;
        const rows = await ctx.db
            .query("pagePresence")
            .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
            .take(MAX_PRESENCE_ROWS);

        const stale = rows.filter((row) => now - row.lastHeartbeat >= STALE_THRESHOLD_MS);

        for (const row of stale) {
            await ctx.db.delete(row._id);
        }

        const own = rows.find((row) => row.sessionId === sessionId && row.userId === userId);

        if (own) {
            await ctx.db.patch(own._id, { isEditing: args.isEditing, lastHeartbeat: now });

            ctx.log.event("pages.heartbeat_page_presence", { isEditing: args.isEditing, isNewSession: false });

            return null;
        }

        const used = new Set(rows.filter((row) => now - row.lastHeartbeat < STALE_THRESHOLD_MS).map((row) => row.userColor));

        await ctx.db.insert("pagePresence", {
            isEditing: args.isEditing,
            lastHeartbeat: now,
            pageId: args.pageId,
            sessionId,
            userColor: USER_COLORS.find((color) => !used.has(color)) ?? USER_COLORS[0]!,
            userId,
            userName: name || "Anonymous",
        });

        ctx.log.event("pages.heartbeat_page_presence", { isEditing: args.isEditing, isNewSession: true });

        return null;
    });

export const leavePagePresence = authMutation
    .use(rateLimit("pages/presence"))
    .input({ sessionId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const rows = await ctx.db
            .query("pagePresence")
            .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId.slice(0, SESSION_ID_MAX)))
            .take(5);

        const own = rows.filter((candidate) => candidate.userId === ctx.user.userId);

        for (const row of own) {
            await ctx.db.delete(row._id);
        }

        ctx.log.event("pages.leave_page_presence", { removed: own.length });

        return null;
    });

/** The OTHER live sessions on a page — the caller's own session is left out. */
export const listPagePresence = authQuery
    .input({ pageId: v.id("pages"), sessionId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(v.object({ isEditing: v.boolean(), isSelf: v.boolean(), userColor: v.string(), userName: v.string() })))
    .query(async ({ args, ctx }) => {
        await requirePageAccess(ctx, args.pageId, ctx.user.userId, "read");

        const now = ctx.now;
        const rows = await ctx.db
            .query("pagePresence")
            .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
            .take(MAX_PRESENCE_ROWS);

        return rows
            .filter((row) => row.sessionId !== args.sessionId && now - row.lastHeartbeat < STALE_THRESHOLD_MS)
            .map((row) => {
                return { isEditing: row.isEditing, isSelf: row.userId === ctx.user.userId, userColor: row.userColor, userName: row.userName };
            });
    });
