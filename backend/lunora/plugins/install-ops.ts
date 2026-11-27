/**
 * The child operations of an install, shared by install and repair. Each child is created in the import's order, and each
 * one follows the same sequence: its intent row (found or recorded), then the create under its marker, then its link.
 * The create finds an existing child by marker, so a retried step makes no second copy.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import type { BundleOps } from "../skills/bundle-plan";
import { markerFor } from "./logic";
import type { ChildKind } from "./logic";

export interface ChildOptions {
    generation: number;
    installId: string;
    /** The intent row for a child. An install records a new one; a repair returns the one it already has. */
    intentFor: (key: string, kind: ChildKind) => Promise<string>;
    isPremium: boolean;
    plan?: string;
    userId: string;
    version: string;
}

export const childOps = (ctx: ActionCtx, options: ChildOptions): BundleOps => {
    const { generation, installId, intentFor, isPremium, plan, userId, version } = options;
    const link = { pluginInstallId: installId };

    /** One child: its intent first, then the create, then its link to the child. */
    const linked = async <T extends { id: string }>(kind: ChildKind, key: string, create: () => Promise<T>): Promise<T> => {
        const intentId = await intentFor(key, kind);
        const created = await create();

        await ctx.runMutation(internal.plugins.install_steps.recordCreated, { generation, installId, intentId, itemId: created.id });

        return created;
    };

    return {
        createGroupChat: async (group, key) => {
            const created = await linked("group", key, async () => {
                const { threadId } = await ctx.runMutation(internal.chat.group.functions.createPluginGroupChat, {
                    ...group,
                    ...link,
                    pluginMarker: markerFor(installId, key),
                    plan,
                    userId,
                });

                return { id: threadId };
            });

            return created.id;
        },
        createSkill: async (skill, key) => {
            const created = await linked("skill", key, async () => ({
                id: await ctx.runMutation(internal.skills.create_skill.createPluginSkill, {
                    ...skill,
                    ...link,
                    enabled: false,
                    isPremium,
                    pluginMarker: markerFor(installId, key),
                    plan,
                    source: { type: "plugin", version },
                    userId,
                    visibility: "private",
                }),
            }));

            return created.id;
        },
        createTrigger: async (trigger, key) => {
            const created = await linked("trigger", key, async () => {
                const { triggerId, webhookSecret } = await ctx.runMutation(internal.triggers.functions.createPluginTrigger, {
                    ...trigger,
                    ...link,
                    pluginMarker: markerFor(installId, key),
                    plan,
                    userId,
                });

                return { id: triggerId, webhookSecret };
            });

            return { triggerId: created.id, ...(created.webhookSecret !== undefined && { webhookSecret: created.webhookSecret }) };
        },
        deleteGroupChat: async (threadId) => await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: threadId, kind: "group", userId }),
        deleteSkill: async (skillId) => await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: skillId, kind: "skill", userId }),
        deleteTrigger: async (triggerId) => await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: triggerId, kind: "trigger", userId }),
    };
};
