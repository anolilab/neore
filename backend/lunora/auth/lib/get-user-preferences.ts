import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";

/**
 * Gets the user's timezone, location, dictation language, and language from their settings in a single query.
 * Works with QueryCtx and MutationCtx contexts that have db access.
 * @param context The query or mutation context
 * @returns An object with timezone, location, dictationLanguage, and language, or undefined values if not set
 */
const getUserPreferences = async (
    context: QueryContext | MutationContext,
    userId: string,
): Promise<{
    dictationLanguage: string | undefined;
    language: string | undefined;
    location: string | undefined;
    timezone: string | undefined;
}> => {
    try {
        const userSettings = await context.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        return {
            dictationLanguage: userSettings?.dictationLanguage ?? undefined,
            language: userSettings?.language ?? undefined,
            location: userSettings?.location ?? undefined,
            timezone: userSettings?.timezone ?? undefined,
        };
    } catch {
        // If query fails, return undefined values
        return {
            dictationLanguage: undefined,
            language: undefined,
            location: undefined,
            timezone: undefined,
        };
    }
};

export default getUserPreferences;
