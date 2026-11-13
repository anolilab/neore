/**
 * A teammate's access to each connection. Its owner sets it (`setTeammateConnectorAccess`); a run reads it through its
 * thread's teammate, never through anything the client sends (`listThreadConnectorAccess`). A connection with no setting
 * is at the default, read and write, so nothing changes for a teammate that was never set.
 *
 * Out of scope here, and follow-ups: per-app action lists, several accounts for one app, and scheduled sync.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { authMutation } from "../lib/crpc";

export const vAccessLevel = v.union(v.literal("read_only"), v.literal("read_write"), v.literal("none"));

/** Longest connector slug a setting may name; a real slug is a short word. */
const SLUG_MAX = 200;

/** Settings one teammate may hold, and the most a run reads. Bounded so every read is complete. */
export const MAX_SETTINGS_PER_TEAMMATE = 200;

/**
 * Removes every setting of a teammate being deleted, in batches, so none is left to a retained thread. Called by `deleteBot`.
 */
export const deleteBotConnectorAccess = async (ctx: Pick<MutationCtx, "db">, botId: Id<"bots">): Promise<void> => {
    for (;;) {
        const rows = await ctx.db
            .query("teammateConnectorAccess")
            .withIndex("by_botId_connectorSlug", (q) => q.eq("botId", botId))
            .take(MAX_SETTINGS_PER_TEAMMATE);

        if (rows.length === 0) {
            return;
        }

        for (const row of rows) {
            await ctx.db.delete("teammateConnectorAccess", row._id);
        }
    }
};

/** Sets one connection's level for one teammate of the caller. A teammate the caller does not own is not found. */
export const setTeammateConnectorAccess = authMutation
    .input({ botId: v.id("bots"), connectorSlug: v.string().max(SLUG_MAX), level: vAccessLevel })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const bot = await ctx.db.get("bots", args.botId);

        if (!bot || bot.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Teammate not found");
        }

        const [existing] = await ctx.db
            .query("teammateConnectorAccess")
            .withIndex("by_botId_connectorSlug", (q) => q.eq("botId", args.botId).eq("connectorSlug", args.connectorSlug))
            .take(1);

        if (existing) {
            await ctx.db.patch("teammateConnectorAccess", existing._id, { level: args.level, updatedAt: ctx.now });
        } else {
            // A run reads at most MAX_SETTINGS_PER_TEAMMATE of a teammate's settings. Past that a read would miss some and treat them
            // as unset, so the setter refuses the new one instead.
            const settings = await ctx.db
                .query("teammateConnectorAccess")
                .withIndex("by_botId_connectorSlug", (q) => q.eq("botId", args.botId))
                .take(MAX_SETTINGS_PER_TEAMMATE);

            if (settings.length >= MAX_SETTINGS_PER_TEAMMATE) {
                throw new LunoraError("BAD_REQUEST", `A teammate can have at most ${MAX_SETTINGS_PER_TEAMMATE} connection settings`);
            }

            await ctx.db.insert("teammateConnectorAccess", {
                botId: args.botId,
                connectorSlug: args.connectorSlug,
                level: args.level,
                updatedAt: ctx.now,
                userId: ctx.user.userId,
            });
        }

        return null;
    });

/**
 * The connection settings of the teammate a thread belongs to, read for a run of that thread. A thread with no teammate,
 * or one the user does not own, has none, so every connection is at the default.
 */
export const threadConnectorAccess = async (
    ctx: Pick<QueryCtx, "db">,
    args: { threadId: Id<"threads">; userId: string },
): Promise<{ connectorSlug: string; level: "none" | "read_only" | "read_write" }[]> => {
    const thread = await ctx.db.get("threads", args.threadId);
    const botId = thread?.botId;

    if (!thread || thread.userId !== args.userId || botId === undefined) {
        return [];
    }

    // A teammate that was deleted keeps its old threads, but its settings do not restrict them: the plain assistant has none.
    if ((await ctx.db.get("bots", botId)) === null) {
        return [];
    }

    const rows = await ctx.db
        .query("teammateConnectorAccess")
        .withIndex("by_botId_connectorSlug", (q) => q.eq("botId", botId))
        .take(MAX_SETTINGS_PER_TEAMMATE);

    return rows.map((row) => {
        return { connectorSlug: row.connectorSlug, level: row.level };
    });
};

export const listThreadConnectorAccess = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.array(v.object({ connectorSlug: v.string(), level: vAccessLevel })))
    .query(async ({ args, ctx }) => await threadConnectorAccess(ctx, args));

/**
 * Every teammate's level on one connection, read for the caller's own teammates. The app proxy uses it for a call that names no
 * thread, so it can only be held to the strictest of them. Read on the caller's own shard, where those rows live.
 */
export const userConnectorAccessForSlug = async (
    ctx: Pick<QueryCtx, "db">,
    args: { connectorSlug: string; userId: string },
): Promise<{ level: "none" | "read_only" | "read_write" }[]> => {
    const rows = await ctx.db
        .query("teammateConnectorAccess")
        .withIndex("by_userId_connectorSlug", (q) => q.eq("userId", args.userId).eq("connectorSlug", args.connectorSlug))
        .take(200);

    return rows.map((row) => {
        return { level: row.level };
    });
};

export const listUserConnectorAccessForSlug = internalQuery
    .input({ connectorSlug: v.string().max(SLUG_MAX), userId: v.string() })
    .output(v.array(v.object({ level: vAccessLevel })))
    .query(async ({ args, ctx }) => await userConnectorAccessForSlug(ctx, args));
