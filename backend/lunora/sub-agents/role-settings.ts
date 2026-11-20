/**
 * Sub-agent roles — the reads. The user's roles live on `userSettings`, a project's overrides on the project row; the
 * writes stay with the modules that own those tables (`auth/functions.ts:setSubAgentRole`,
 * `projects/functions.ts:setProjectSubAgentRole`). The rules themselves are in `roles.ts`.
 */
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { readUserRunPlan } from "../auth/lib/plan";
import { backupFilterRejection } from "../chat/lib/backup-model";
import type { StoredCustomProvider } from "../chat/lib/custom-providers";
import { isLocalBrowserProvider } from "../chat/lib/custom-providers";
import { allowsPaidModel, byokPaysFor, paidModelRefusal } from "../chat/lib/paid-model";
import { authQuery } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { readableProject } from "../projects/functions";
import type { SubAgentRoleConfig, SubAgentRoles } from "./roles";
import { buildRoleCatalog, isRoleModelAllowed, mergeSubAgentRoles } from "./roles";
import { vSubAgentRoles } from "./validators";

const userRoles = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<SubAgentRoles | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return settings?.subAgentRoles ?? undefined;
};

/**
 * Why `userId`'s runs cannot use `modelId` for a role, or `undefined` when they can: the sub-agent rule, then the
 * checks a run makes before it calls the model (the user's model filters, and a paid model needing a plan or the
 * user's own key), so a role is refused when it is saved or named, never after the run was charged.
 */
export const roleModelRefusal = async (ctx: QueryCtx | MutationCtx, userId: string, modelId: string): Promise<string | undefined> => {
    if (!isRoleModelAllowed(modelId)) {
        return `${modelId} cannot run sub-agents.`;
    }

    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
    const custom = parseCustomModelId(modelId);

    // The user's own endpoint, under the checks `resolveRunModel` makes: theirs, on, and one the server can call.
    if (custom) {
        const provider = (preferences?.customAIProviders as Record<string, StoredCustomProvider> | undefined)?.[custom.providerId];

        if (!provider?.enabled) {
            return `${modelId} is not one of your enabled custom endpoints.`;
        }

        return isLocalBrowserProvider(provider.type) ? `${modelId} runs in your browser, and sub-agents run on the server.` : undefined;
    }

    const definition = MODEL_LOOKUP.get(modelId);

    if (!definition) {
        return `${modelId} is not a known model.`;
    }

    const excluded = backupFilterRejection(definition, preferences?.modelFilterRules ?? undefined);

    if (excluded) {
        return `Your model filters exclude ${definition.name ?? modelId}: ${excluded}`;
    }

    const allowed = await allowsPaidModel(
        definition,
        async () => await readUserRunPlan(ctx, userId),
        async () => {
            const entry = (preferences?.providerApiKeys as Record<string, { enabled?: boolean; encryptedKey?: string }> | undefined)?.[definition.provider];

            return Boolean(entry?.enabled && entry.encryptedKey);
        },
    );

    return allowed ? undefined : paidModelRefusal(definition.name ?? modelId, byokPaysFor(definition));
};

/** Why a role config cannot be saved for `userId`, or `undefined`: its effort out of the 0–100 scale, or its model. */
export const roleConfigRefusal = async (ctx: QueryCtx | MutationCtx, userId: string, config: SubAgentRoleConfig | null): Promise<string | undefined> => {
    if (config?.reasoningEffort !== undefined && !(config.reasoningEffort >= 0 && config.reasoningEffort <= 100)) {
        return "Reasoning effort must be between 0 and 100.";
    }

    return config?.model ? await roleModelRefusal(ctx, userId, config.model) : undefined;
};

/**
 * The roles in effect for `userId` in a project (or none): the user's, overridden field by field by the project's.
 * The project is read under the rule a run in it is (owner or organization member), so a member's runs follow the
 * owner's overrides; each model still has to pass the running user's checks at admission.
 */
export const effectiveRoles = async (ctx: QueryCtx | MutationCtx, userId: string, projectId: Id<"projects"> | undefined): Promise<SubAgentRoles> => {
    const [user, project] = await Promise.all([userRoles(ctx, userId), projectId ? readableProject(ctx, projectId, userId) : null]);

    return mergeSubAgentRoles(user, project?.subAgentRoles ?? undefined);
};

/** The settings screen: the user's roles and, for a project, its overrides and whether this user may change them. */
export const getSubAgentRoles = authQuery
    .input({ projectId: v.optional(v.id("projects")) })
    .output(
        v.object({
            project: v.union(v.object({ editable: v.boolean(), roles: vSubAgentRoles }), v.null()),
            user: vSubAgentRoles,
        }),
    )
    .query(async ({ args: { projectId }, ctx }) => {
        const { userId } = ctx.user;
        const [user, project] = await Promise.all([userRoles(ctx, userId), projectId ? readableProject(ctx, projectId, userId) : null]);

        return {
            project: project ? { editable: !project.userId || project.userId === userId, roles: project.subAgentRoles ?? {} } : null,
            user: user ?? {},
        };
    });

/** The lead's role catalog for a run in `projectId` (or none), or `null` when no role has a model. */
export const getRoleCatalogForRun = internalQuery
    .input({ projectId: v.optional(v.id("projects")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { projectId, userId }, ctx }) => buildRoleCatalog(await effectiveRoles(ctx, userId, projectId)) ?? null);
