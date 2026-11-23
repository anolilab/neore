/**
 * Document version history queries.
 * Reads from the `documentVersions` table (explicit snapshots created on each update).
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { systemDb } from "../lib/rls/scope";
import { meetsThreadPermission, resolveThreadReadAccess } from "./thread-read-access";

/**
 * The document a history read is about, or `null`. With its thread, the read goes through the thread's read grant, so a member reads the
 * history of a document they can read; the call routes to the thread owner's shard by that id. Without one, only the author reads, and
 * only while the thread still admits them.
 */
const historyDocument = async (
    ctx: QueryCtx,
    args: { documentId: Id<"documents">; threadId?: Id<"threads"> },
    userId: string,
): Promise<Doc<"documents"> | null> => {
    if (args.threadId !== undefined) {
        const access = await resolveThreadReadAccess(ctx, args.threadId, userId, undefined, { primary: true });

        if (access?.kind !== "full" || !meetsThreadPermission(access.permission, "read")) {
            return null;
        }

        const row = await ctx.db.get("documents", args.documentId);

        return row && row.threadId === args.threadId ? row : null;
    }

    const row = await ctx.db.get("documents", args.documentId);

    if (!row || row.userId !== userId) {
        return null;
    }

    const access = await resolveThreadReadAccess(ctx, row.threadId, userId, undefined, { primary: true });

    return access?.kind === "full" && meetsThreadPermission(access.permission, "read") ? row : null;
};

export const listVersions = query
    .input({
        documentId: v.id("documents"),
        limit: v.optional(v.number()),
        // The document's thread: the read routes to its owner's shard and goes through the thread's grant (see `historyDocument`).
        threadId: v.optional(v.id("threads")),
    })
    .output(
        v.array(
            v.object({
                createdAt: v.number(),
                hasCommit: v.boolean(),
                userId: v.string(),
                version: v.number(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        const documentRow = await historyDocument(ctx, args, identity.userId);

        if (!documentRow) {
            return [];
        }

        const limit = args.limit ?? 50;

        // Past row-level security: the versions of a document are read by whoever `historyDocument` admitted, not only by their author.
        const versions = await systemDb(ctx)
            .query("documentVersions")
            .withIndex("by_documentId_version", (q) => q.eq("documentId", args.documentId))
            .order("desc")
            .take(limit);

        return versions.map((version) => {
            return {
                createdAt: version.createdAt,
                hasCommit: version.commit != null,
                userId: version.userId,
                version: version.version,
            };
        });
    });

export const getVersion = query
    .input({
        documentId: v.id("documents"),
        // The document's thread, as in `listVersions`.
        threadId: v.optional(v.id("threads")),
        version: v.number(),
    })
    .output(
        v.union(
            v.object({
                commit: v.optional(v.any()),
                content: v.optional(v.string()),
                contentJson: v.optional(v.any()),
                createdAt: v.number(),
                userId: v.string(),
                version: v.number(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const documentRow = await historyDocument(ctx, args, identity.userId);

        if (!documentRow) {
            return null;
        }

        // Past row-level security, for the same reason as `listVersions`: the access decision was made in `historyDocument`.
        const entry = await systemDb(ctx)
            .query("documentVersions")
            .withIndex("by_documentId_version", (q) => q.eq("documentId", args.documentId).eq("version", args.version))
            .first();

        if (!entry) {
            return null;
        }

        return {
            commit: entry.commit ?? undefined,
            content: entry.content ?? undefined,
            contentJson: entry.contentJson ?? undefined,
            createdAt: entry.createdAt,
            userId: entry.userId,
            version: entry.version,
        };
    });
