/**
 * Sub-agent roles — the reads. The user's roles live on `userSettings`, a project's overrides on the project row; the
 * writes stay with the modules that own those tables (`auth/functions.ts:setSubAgentRole`,
 * `projects/functions.ts:setProjectSubAgentRole`). The rules themselves are in `roles.ts`.
 */
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { readUserRunPlan } from "../auth/lib/plan";
import { backupFilterRejection } from "../chat/lib/backup-model";
import type { StoredCustomProvider } from "../chat/lib/custom-providers";
import { isLocalBrowserProvider } from "../chat/lib/custom-providers";
import { allowsPaidModel, byokPaysFor, paidModelRefusal } from "../chat/lib/paid-model";
import { authQuery } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { mayEditProject } from "../projects/edit-access";
import { readableProject } from "../projects/functions";
import type { SubAgentRoleConfig, SubAgentRoleName, SubAgentRoles } from "./roles";
import { activeRoles, buildRoleCatalog, isRoleModelAllowed, mergeSubAgentRoles } from "./roles";
import { vSubAgentRoles } from "./validators";

const userRoles = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<SubAgentRoles | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return settings?.subAgentRoles ?? undefined;
};

/** The rows {@link roleModelRefusal} reads for a user, each read once however many models it checks. */
interface RoleCheckReads {
    plan: () => ReturnType<typeof readUserRunPlan>;
    preferences: () => Promise<Doc<"aiUserPreferences"> | null>;
}

const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let result: Promise<T> | undefined;

    return async () => {
        result ??= read();

        return await result;
    };
};

const roleCheckReads = (ctx: QueryCtx | MutationCtx, userId: string): RoleCheckReads => {
    return {
        plan: once(async () => await readUserRunPlan(ctx, userId)),
        preferences: once(
            async () =>
                await ctx.db
                    .query("aiUserPreferences")
                    .withIndex("by_userId", (q) => q.eq("userId", userId))
                    .unique(),
        ),
    };
};

/**
 * Why `userId`'s runs cannot use `modelId` for a role, or `undefined` when they can: the sub-agent rule, then the
 * checks a run makes before it calls the model (the user's model filters, and a paid model needing a plan or the
 * user's own key), so a role is refused when it is saved or named, never after the run was charged.
 */
export const roleModelRefusal = async (
    ctx: QueryCtx | MutationCtx,
    userId: string,
    modelId: string,
    reads: RoleCheckReads = roleCheckReads(ctx, userId),
): Promise<string | undefined> => {
    if (!isRoleModelAllowed(modelId)) {
        return `${modelId} cannot run sub-agents.`;
    }

    const preferences = await reads.preferences();
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

    const allowed = await allowsPaidModel(definition, reads.plan, async () => {
        const entry = (preferences?.providerApiKeys as Record<string, { enabled?: boolean; encryptedKey?: string }> | undefined)?.[definition.provider];

        return Boolean(entry?.enabled && entry.encryptedKey);
    });

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
 * owner's overrides; each model still has to pass the running user's checks at admission. `ownersInstructions` names
 * the roles whose instructions come from a project another user owns: a run labels those as the owner's
 * (`instructionsBy`), never as the running user's.
 */
export const effectiveRoleSettings = async (
    ctx: QueryCtx | MutationCtx,
    userId: string,
    projectId: Id<"projects"> | undefined,
): Promise<{ ownersInstructions: ReadonlySet<SubAgentRoleName>; roles: SubAgentRoles }> => {
    const [user, project] = await Promise.all([userRoles(ctx, userId), projectId ? readableProject(ctx, projectId, userId) : null]);
    const overrides = project?.subAgentRoles ?? undefined;
    const ownersInstructions = new Set<SubAgentRoleName>(
        project && project.userId !== userId && overrides
            ? (Object.keys(overrides) as SubAgentRoleName[]).filter((name) => overrides[name]?.instructions !== undefined)
            : [],
    );

    return { ownersInstructions, roles: mergeSubAgentRoles(user, overrides) };
};

/** How far up a delegation chain {@link delegationProjectId} looks: the lead, a child, a grandchild (depth ≤ 2). */
const CHAIN_HOPS = 3;

/**
 * The project a delegation from `threadId` works in: the thread's own, else the one of the thread that delegated to
 * it, up to the lead. A sub-agent's or worker's thread has no project, so without this a role named below the lead
 * would drop the project's overrides.
 */
export const delegationProjectId = async (ctx: QueryCtx | MutationCtx, threadId: string): Promise<Id<"projects"> | undefined> => {
    let current = threadId;

    for (let hop = 0; hop < CHAIN_HOPS; hop += 1) {
        const thread = await ctx.db.get("threads", current as Id<"threads">);

        if (thread?.projectId) {
            return thread.projectId as Id<"projects">;
        }

        const run = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_childThreadId", (q) => q.eq("childThreadId", current))
            .first();

        if (!run) {
            return undefined;
        }

        current = run.parentThreadId;
    }

    return undefined;
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
            project: project ? { editable: mayEditProject(project, userId), roles: project.subAgentRoles ?? {} } : null,
            user: user ?? {},
        };
    });

/**
 * The lead's role catalog for a run on `threadId` (in its delegation's project, {@link delegationProjectId}), or `null`
 * when no role is on. A role whose model
 * `roleModelRefusal` refuses for this user (another member's endpoint, a lapsed plan) is left out: `createRun` would
 * refuse every call naming it.
 */
export const getRoleCatalogForRun = internalQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { threadId, userId }, ctx }) => {
        const { roles } = await effectiveRoleSettings(ctx, userId, await delegationProjectId(ctx, threadId));
        const reads = roleCheckReads(ctx, userId);
        const refused = new Set<string | undefined>(
            await Promise.all(
                activeRoles(roles).map(async (name) => {
                    const model = roles[name]?.model;

                    return model && (await roleModelRefusal(ctx, userId, model, reads)) ? name : undefined;
                }),
            ),
        );
        const runnable = Object.fromEntries(Object.entries(roles).filter(([name]) => !refused.has(name))) as SubAgentRoles;

        return buildRoleCatalog(runnable) ?? null;
    });
