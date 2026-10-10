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
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { withoutUndefined } from "../../lib/patch";

type Database = MutationCtx["db"];

/** The `aiUserPreferences` columns other modules set. */
export type AiUserPreferencesPatch = Partial<Pick<Doc<"aiUserPreferences">, "browserSettings" | "customAIProviders" | "toolPermissions">>;

/** The `userSettings` columns other modules set. */
export type UserSettingsPatch = Partial<Pick<Doc<"userSettings">, "dailyBriefEnabled">>;

/** Patch the user's `aiUserPreferences` row, or create it when `existing` is `null`. */
export const saveAiUserPreferences = async (
    db: Database,
    existing: { _id: Id<"aiUserPreferences"> } | null,
    userId: string,
    fields: AiUserPreferencesPatch,
): Promise<void> => {
    if (existing) {
        await db.patch(existing._id, withoutUndefined(fields));
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
): Promise<void> => {
    if (existing) {
        await db.patch(existing._id, withoutUndefined(fields));
    } else {
        await db.insert("userSettings", { ...fields, userId });
    }
};
