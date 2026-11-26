/**
 * The uninstall procedure: begin (refuse, lease, sweep), delete the plugin's empty group chats in pages, then finish (links and
 * install). The group chats are deleted from here because their deletion is paged and only runs from an action.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { claimGroupForDelete, finishUninstallRows, uninstallRows } from "./uninstall";

export const beginUninstall = internalMutation
    .input({ pluginSlug: v.string().max(64), userId: v.string().max(128) })
    .output(
        v.object({
            generation: v.number(),
            groups: v.array(v.string()),
            installId: v.string(),
            kept: v.array(v.string()),
            removed: v.number(),
        }),
    )
    .mutation(async ({ args, ctx }) => await uninstallRows(ctx, args.userId, args.pluginSlug));

export const claimGroup = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128), threadId: v.string().max(128) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await claimGroupForDelete(ctx, args.installId, args.generation, args.threadId));

export const finishUninstall = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await finishUninstallRows(ctx, args.installId, args.generation);

        return null;
    });

export const uninstallPlugin = authAction
    .input({ pluginSlug: v.string().max(64) })
    .output(v.object({ kept: v.array(v.string()), removed: v.number() }))
    .action(async ({ args, ctx }) => {
        const begun = await ctx.runMutation(internal.plugins.uninstall_action.beginUninstall, {
            pluginSlug: args.pluginSlug,
            userId: ctx.user.userId,
        });
        const kept = [...begun.kept];

        for (const threadId of begun.groups) {
            const mayDelete = await ctx.runMutation(internal.plugins.uninstall_action.claimGroup, {
                generation: begun.generation,
                installId: begun.installId,
                threadId,
            });

            if (!mayDelete) {
                kept.push(threadId);
                continue;
            }

            let isDone = false;

            while (!isDone) {
                const page = await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: threadId as Id<"threads"> });

                isDone = page.isDone;
            }
        }

        await ctx.runMutation(internal.plugins.uninstall_action.finishUninstall, { generation: begun.generation, installId: begun.installId });

        return { kept, removed: begun.removed };
    });
