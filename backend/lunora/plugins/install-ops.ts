/**
 * The child operations of an install, shared by install and repair. Each child is created in the import's order, and each
 * one follows the same sequence: its intent row (found or recorded), then the create under its marker, then its link.
 * The create finds an existing child by marker, so a retried step makes no second copy.
 */
import { LunoraError } from "lunorash/server";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import { BundleImportError } from "../skills/bundle-plan";
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

/**
 * What an action throws for a failed import. A rate limit keeps its code and retry hint, so a client retries it; any other
 * import failure is a bad request.
 */
export const importFailure = (error: unknown): unknown => {
    if (!(error instanceof BundleImportError)) {
        return error;
    }

    if (error.resumable && error.cause instanceof LunoraError) {
        return new LunoraError(error.cause.code, error.message, { data: error.cause.data });
    }

    return new LunoraError("BAD_REQUEST", error.message);
};

export const childOps = (ctx: ActionCtx, options: ChildOptions): BundleOps => {
    const { generation, installId, intentFor, isPremium, plan, userId, version } = options;
    // `generation` rides with every create, so a stale action cannot start a child after a takeover.
    const link = { generation, pluginInstallId: installId };
    // Once another action has taken the install over, this one must not delete anything: the children it made now belong to that
    // action's repair (found by marker), and a rollback here would remove ones the new holder has already linked.
    let lostLease = false;

    const keepLease = async <T>(step: () => Promise<T>): Promise<T> => {
        try {
            return await step();
        } catch (error) {
            if (error instanceof Error && error.message.includes("STALE_LEASE")) {
                lostLease = true;
            }

            throw error;
        }
    };

    // A create that failed for another reason can follow a takeover, so each delete checks, in the mutation that deletes, that this
    // action still holds the install.
    const remove = async (id: string, kind: ChildKind): Promise<{ kept: boolean; leaseLost?: boolean } | undefined> => {
        if (lostLease) {
            return undefined;
        }

        const outcome = await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id, kind, lease: { generation, installId }, userId });

        if (outcome.leaseLost === true) {
            lostLease = true;
        }

        return outcome;
    };

    /** One child: its intent first, then the create, then its link to the child. */
    const linked = async <T extends { id: string }>(kind: ChildKind, key: string, create: () => Promise<T>): Promise<T> => {
        const intentId = await keepLease(async () => await intentFor(key, kind));
        let created: T;

        try {
            created = await create();
        } catch (error) {
            // A create can throw after its first write (a skill's row commits before its bookkeeping rows), leaving a child that is in
            // no rollback list. It is found by its marker and removed like a child whose link failed; one that cannot be removed is named.
            if (!lostLease && !(error instanceof Error && error.message.includes("STALE_LEASE"))) {
                // A failed lookup is not an absent child: the child may exist, so it is named and the install is kept for repair.
                let lookupFailed = false;
                const childId = await ctx
                    .runMutation(internal.plugins.repair_resume.childIdForMarker, { kind, marker: markerFor(installId, key), userId })
                    .catch(() => {
                        lookupFailed = true;

                        return null;
                    });

                if (lookupFailed && !lostLease) {
                    throw new BundleImportError(error instanceof Error ? error.message : "The child could not be created", [key]);
                }

                if (childId !== null) {
                    const removed = await remove(childId, kind)
                        .then((outcome) => outcome !== undefined && !outcome.kept)
                        .catch(() => false);

                    if (!removed && !lostLease) {
                        throw new BundleImportError(error instanceof Error ? error.message : "The child could not be created", [key]);
                    }
                }
            }

            throw error;
        }

        try {
            await keepLease(
                async () => await ctx.runMutation(internal.plugins.install_steps.recordCreated, { generation, installId, intentId, itemId: created.id }),
            );
        } catch (error) {
            // The child is not in the import's rollback list yet, so it is removed here. A lost lease keeps it: its marker lets the
            // new holder's repair link it. A child that cannot be removed is named, so the install is kept for repair.
            if (!lostLease) {
                const removed = await remove(created.id, kind)
                    .then((outcome) => outcome !== undefined && !outcome.kept)
                    .catch(() => false);

                if (lostLease) {
                    throw error;
                }

                if (!removed) {
                    throw new BundleImportError(error instanceof Error ? error.message : "The child could not be linked", [key]);
                }
            }

            throw error;
        }

        return created;
    };

    return {
        createGroupChat: async (group, key) => {
            const created = await linked("group", key, async () => {
                const { threadId } = await ctx.runMutation(internal.chat.group.functions.createPluginGroupChat, {
                    ...group,
                    ...link,
                    plan,
                    pluginMarker: markerFor(installId, key),
                    userId,
                });

                return { id: threadId };
            });

            return created.id;
        },
        createSkill: async (skill, key) => {
            const created = await linked("skill", key, async () => {
                return {
                    id: await ctx.runMutation(internal.skills.create_skill.createPluginSkill, {
                        ...skill,
                        ...link,
                        enabled: false,
                        isPremium,
                        plan,
                        pluginMarker: markerFor(installId, key),
                        source: { type: "plugin", version },
                        userId,
                        visibility: "private",
                    }),
                };
            });

            return created.id;
        },
        createTrigger: async (trigger, key) => {
            const created = await linked("trigger", key, async () => {
                const { triggerId, webhookSecret } = await ctx.runMutation(internal.triggers.functions.createPluginTrigger, {
                    ...trigger,
                    ...link,
                    plan,
                    pluginMarker: markerFor(installId, key),
                    userId,
                });

                return { id: triggerId, webhookSecret };
            });

            return { triggerId: created.id, ...(created.webhookSecret !== undefined && { webhookSecret: created.webhookSecret }) };
        },
        deleteGroupChat: async (threadId) => await remove(threadId, "group"),
        deleteSkill: async (skillId) => await remove(skillId, "skill"),
        deleteTrigger: async (triggerId) => await remove(triggerId, "trigger"),
    };
};
