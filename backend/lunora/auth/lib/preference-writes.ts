/**
 * The auth module's write surface for the per-user settings rows it owns
 * (`aiUserPreferences`, `userSettings` — `auth/module.ts`), for OTHER modules:
 * chat's custom endpoints, tool permissions and browser settings, the Daily
 * Brief toggle. The patch types list the columns written from outside.
 *
 * Plain functions over `ctx.db`, so the write stays in the caller's mutation
 * (same transaction, same shard, same RLS-guarded `ctx.db`). The caller looks
 * the row up itself and passes it (or `null`), exactly as it did before.
 * `undefined` in a patch means "leave the column unchanged" (`withoutUndefined`).
 */
import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { withoutUndefined } from "../../lib/patch";
import { isManagedSetting, lockedKeysInPatch, readPolicyState } from "./organization-policy";

type Database = MutationCtx["db"];

/** The `aiUserPreferences` columns other modules set. */
export type AiUserPreferencesPatch = Partial<
    Pick<
        Doc<"aiUserPreferences">,
        | "autoApproveLowRisk"
        | "browserSettings"
        | "codingAgentCommitIdentity"
        | "customAIProviders"
        | "lowRiskTrustedServers"
        | "mcpSecretHeaders"
        | "mcpServers"
        | "providerApiKeys"
        | "toolPermissionGrants"
        | "toolPermissions"
    >
>;

/** The `userSettings` columns other modules set. */
export type UserSettingsPatch = Partial<Pick<Doc<"userSettings">, "dailyBriefEnabled" | "setupStepsSkipped" | "taskEmailEnabled">>;

/**
 * Refuse a write to a setting the caller's organization locks. `organizationId`
 * is the caller's ACTIVE organization (`ctx.user.activeOrganization?.id`), never
 * an id from args; `null` for a writer with no organization (an internal job).
 * The policy is read only when the patch carries a managed key, so the other
 * writes pay nothing. A policy that cannot be read refuses the managed keys.
 */
export const assertSettingsWritable = async (db: Database, organizationId: string | null, fields: Readonly<Record<string, unknown>>): Promise<void> => {
    if (organizationId === null || Object.keys(fields).every((key) => fields[key] === undefined || !isManagedSetting(key))) {
        return;
    }

    const row = await db.organizationPolicies.findFirst({ where: { organizationId } });
    const locked = lockedKeysInPatch(fields, readPolicyState(row?.document));

    if (locked.length > 0) {
        throw new LunoraError("FORBIDDEN", `Managed by your organization: ${locked.join(", ")}`);
    }
};

/** Patch the user's `aiUserPreferences` row, or create it when `existing` is `null`. */
export const saveAiUserPreferences = async (
    db: Database,
    existing: { _id: Id<"aiUserPreferences"> } | null,
    userId: string,
    fields: AiUserPreferencesPatch,
    organizationId: string | null,
): Promise<void> => {
    await assertSettingsWritable(db, organizationId, fields);

    if (existing) {
        await db.patch("aiUserPreferences", existing._id, withoutUndefined(fields));
    } else {
        await db.insert("aiUserPreferences", { ...fields, userId });
    }
};

/** Patch the user's `userSettings` row, or create it when `existing` is `null`. */
export const saveUserSettings = async (
    db: Database,
    existing: { _id: Id<"userSettings"> } | null,
    userId: string,
    fields: UserSettingsPatch,
    organizationId: string | null,
): Promise<void> => {
    await assertSettingsWritable(db, organizationId, fields);

    if (existing) {
        await db.patch("userSettings", existing._id, withoutUndefined(fields));
    } else {
        await db.insert("userSettings", { ...fields, userId });
    }
};
