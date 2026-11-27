/**
 * The uninstall procedure: begin (refuse, lease, sweep), delete the plugin's empty group chats in pages, then finish (links and
 * install). The group chats are deleted from here because their deletion is paged and only runs from an action.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { claimGroupForDelete, finishUninstallRows, SKILLS_PER_CALL, uninstallRows } from "./uninstall";

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
        // Set on the calls after the first: the kept groups were reported by that one.
        settled: v.optional(v.boolean()),
    })
    .output(v.object({ hasMore: v.boolean(), kept: v.array(v.string()), removed: v.number() }))
    .mutation(
        async ({ args, ctx }) =>
            await finishUninstallRows(ctx, args.installId, args.generation, {
                keptGroups: args.keptGroups,
                pendingSkills: args.pendingSkills,
                settled: args.settled,
            }),
    );

export const uninstallPlugin = authAction
    .input({ pluginSlug: v.string().max(64) })
    .output(v.object({ kept: v.array(v.string()), removed: v.number() }))
    .action(async ({ args, ctx }) => {
        // As the other plugin actions: an organization session would act on the personal install.
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

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
                keptGroups.push(threadId);
                continue;
            }

            // The action owns the pagination: each incomplete page hands back where it stopped, and that goes into the next call.
            // The first call rechecks that the group is still empty; later ones carry the continuation.
            let next:
                | { cursor?: string; deltaCursor?: string; messagesDone: boolean; pinsDone: boolean; streamOrder?: number; streamsDone: boolean }
                | undefined;

            for (;;) {
                const page = await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, {
                    ...next,
                    pluginInstallId: begun.installId,
                    threadId: threadId as Id<"threads">,
                });

                if (page.kept === true) {
                    keptGroups.push(threadId);
                    break;
                }

                if (page.isDone) {
                    break;
                }

                if (!page.next) {
                    throw new Error("The group chat deletion stopped without saying where");
                }

                next = page.next;
            }
        }

        let finished = await ctx.runMutation(internal.plugins.uninstall_action.finishUninstall, {
            generation: begun.generation,
            installId: begun.installId,
            keptGroups,
            pendingSkills: begun.pendingSkills,
        });
        let finishedKept = finished.kept;
        let finishedRemoved = finished.removed;

        // A few skills, then a few links, a call: go on until the skills, the links and the install are gone.
        let remaining = begun.pendingSkills.slice(SKILLS_PER_CALL);

        while (finished.hasMore) {
            finished = await ctx.runMutation(internal.plugins.uninstall_action.finishUninstall, {
                generation: begun.generation,
                installId: begun.installId,
                keptGroups,
                pendingSkills: remaining,
                settled: true,
            });
            remaining = remaining.slice(SKILLS_PER_CALL);
            finishedKept = [...finishedKept, ...finished.kept];
            finishedRemoved += finished.removed;
        }

        return { kept: [...kept, ...finishedKept], removed: begun.removed + finishedRemoved };
    });
