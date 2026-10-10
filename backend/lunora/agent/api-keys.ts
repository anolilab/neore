/**
 * API key operations for playground authentication.
 * Migrated from `@neore/backend-agent` component.
 *
 * NOTE: Table renamed from 'apiKeys' to 'playgroundApiKeys' for clarity.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { getAuthUserIdentity } from "../auth";

export const issue = internalMutation
    .input({
        name: v.optional(v.string()),
    })
    .output(v.id("playgroundApiKeys"))
    .mutation(async ({ args, ctx }) => {
        if (args.name) {
            const existingApiKey = await ctx.db
                .query("playgroundApiKeys") // RENAMED: apiKeys -> playgroundApiKeys
                .withIndex("name", (q) => q.eq("name", args.name))
                .first();

            if (existingApiKey) {
                console.warn(`API key ${args.name} already exists, deleting...`);
                await ctx.db.delete(existingApiKey._id);
            }
        }

        const insertedId = await ctx.db.insert("playgroundApiKeys", args);

        return insertedId as Id<"playgroundApiKeys">;
    });

// Internal: a key id IS the credential, so a client-reachable "does this id
// exist" is an oracle over every playground key. Nothing calls it.
export const validate = internalQuery
    .input({
        apiKey: v.id("playgroundApiKeys"), // RENAMED: apiKeys -> playgroundApiKeys
    })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        // Require authentication to prevent unauthenticated key ID enumeration
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            throw new LunoraError("UNAUTHORIZED", "Unauthorized");
        }

        const apiKey = await ctx.db.get(args.apiKey);

        if (!apiKey) {
            throw new LunoraError("UNAUTHORIZED", "Invalid API key");
        }

        return true;
    });

export const destroy = internalMutation
    .input({
        apiKey: v.optional(v.id("playgroundApiKeys")), // RENAMED: apiKeys -> playgroundApiKeys
        name: v.optional(v.string()),
    })
    .output(v.union(v.literal("missing"), v.literal("deleted"), v.literal("name mismatch"), v.literal("must provide either apiKey or name")))
    .mutation(async ({ args, ctx }) => {
        if (args.apiKey) {
            const apiKey = await ctx.db.get(args.apiKey);

            if (!apiKey) {
                return "missing";
            }

            if (apiKey.name !== args.name) {
                return "name mismatch";
            }

            await ctx.db.delete(args.apiKey);
        } else if (args.name) {
            const apiKey = await ctx.db
                .query("playgroundApiKeys") // RENAMED: apiKeys -> playgroundApiKeys
                .withIndex("name", (q) => q.eq("name", args.name))
                .first();

            if (!apiKey) {
                return "missing";
            }

            await ctx.db.delete(apiKey._id);
        } else {
            return "must provide either apiKey or name";
        }

        return "deleted";
    });
