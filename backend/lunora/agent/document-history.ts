/**
 * Document version history queries.
 * Reads from the `documentVersions` table (explicit snapshots created on each update).
 */
import { v } from "lunorash/server";

import { query } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";

export const listVersions = query
    .input({
        documentId: v.id("documents"),
        limit: v.optional(v.number()),
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

        const documentRow = await ctx.db.get(args.documentId);

        if (!documentRow || documentRow.userId !== identity.userId) {
            return [];
        }

        const limit = args.limit ?? 50;

        const versions = await ctx.db
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

        const documentRow = await ctx.db.get(args.documentId);

        if (!documentRow || documentRow.userId !== identity.userId) {
            return null;
        }

        const entry = await ctx.db
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
