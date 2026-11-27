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
            pendingSkills: v.array(v.string()),
            removed: v.number(),
        }),
    )
    .mutation(async ({ args, ctx }) => await uninstallRows(ctx, args.userId, args.pluginSlug));

export const claimGroup = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128), threadId: v.string().max(128) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await claimGroupForDelete(ctx, args.installId, args.generation, args.threadId));

export const finishUninstall = internalMutation
    .input({
        generation: v.number(),
        installId: v.string().max(128),
        keptGroups: v.array(v.string().max(128)).max(300),
        pendingSkills: v.array(v.string().max(128)).max(500),
    })
    .output(v.object({ kept: v.array(v.string()), removed: v.number() }))
    .mutation(
        async ({ args, ctx }) =>
            await finishUninstallRows(ctx, args.installId, args.generation, { keptGroups: args.keptGroups, pendingSkills: args.pendingSkills }),
    );

export const uninstallPlugin = authAction
    .input({ pluginSlug: v.string().max(64) })
    .output(v.object({ kept: v.array(v.string()), removed: v.number() }))
    .action(async ({ args, ctx }) => {
        const begun = await ctx.runMutation(internal.plugins.uninstall_action.beginUninstall, {
            pluginSlug: args.pluginSlug,
            userId: ctx.user.userId,
        });
        const kept = [...begun.kept];
        const keptGroups: string[] = [];

        for (const threadId of begun.groups) {
            const mayDelete = await ctx.runMutation(internal.plugins.uninstall_action.claimGroup, {
                generation: begun.generation,
                installId: begun.installId,
                threadId,
            });

            if (!mayDelete) {
                kept.push(threadId);
                keptGroups.push(threadId);
                continue;
            }

            let isDone = false;
            let isFirst = true;

            while (!isDone) {
                // The first page rechecks, in its own transaction, that no message arrived since the claim; a group that gained one is kept.
                const page = await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, {
                    threadId: threadId as Id<"threads">,
                    ...(isFirst && { pluginInstallId: begun.installId }),
                });

                if (page.kept === true) {
                    kept.push(threadId);
                    keptGroups.push(threadId);
                    break;
                }

                isFirst = false;
                isDone = page.isDone;
            }
        }

        const finished = await ctx.runMutation(internal.plugins.uninstall_action.finishUninstall, {
            generation: begun.generation,
            installId: begun.installId,
            keptGroups,
            pendingSkills: begun.pendingSkills,
        });

        return { kept: [...kept, ...finished.kept], removed: begun.removed + finished.removed };
    });
