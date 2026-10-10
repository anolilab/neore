import { internal } from "../../_generated/internal";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";
import type { ThreadDoc } from "../../agent/client";
import type { ThreadPermission } from "../../agent/thread-read-access";
import { throwUnauthorized } from "../../lib/error-helpers";
import { gatewayFetchFor } from "../../lib/services";
import getAgent from "./get-agent";

/** Any context a thread-access check may be called from. */
type AnyThreadContext = QueryContext | MutationContext | ActionContext;

/**
 * Validates that a user has access to a thread with the specified permission level.
 * Throws an error if access is denied.
 * @param context The context (Query, Mutation, or Action)
 * @param threadId The ID of the thread to check access for
 * @param userId The ID of the user to check access for
 * @param requiredPermission The required permission level ("read", "write", or "admin")
 * @throws {LunoraError} If the user does not have the required permission
 */
export const validateThreadAccess = async (
    context: AnyThreadContext,
    threadId: string,
    userId: string,
    requiredPermission: ThreadPermission = "read",
): Promise<void> => {
    const hasAccess = await context.runQuery(internal.chat.sharing.checkThreadAccess, {
        requiredPermission,
        threadId,
        userId,
    });

    if (!hasAccess) {
        const permissionMessages: Record<string, string> = {
            admin: "Admin access denied to this thread",
            read: "Access denied to this thread",
            write: "Write access denied to this thread",
        };

        throwUnauthorized(permissionMessages[requiredPermission]);
    }
};

/**
 * Validates thread access and returns thread data in one call.
 * This is more efficient than calling validateThreadAccess + getThread separately
 * as it eliminates duplicate thread fetches.
 * @param context The context (Query, Mutation, or Action)
 * @param threadId The ID of the thread to check access for
 * @param userId The ID of the user to check access for
 * @param requiredPermission The required permission level ("read", "write", or "admin")
 * @returns The thread data and permission level
 * @throws {LunoraError} If the user does not have the required permission
 */
export const validateThreadAccessWithData = async (
    context: AnyThreadContext,
    threadId: string,
    userId: string,
    requiredPermission: ThreadPermission = "read",
): Promise<{ permission: ThreadPermission; thread: ThreadDoc }> => {
    const result = await context.runQuery(internal.chat.sharing.checkThreadAccessWithData, {
        requiredPermission,
        threadId,
        userId,
    });

    if (!result.hasAccess || !result.thread || !result.permission) {
        const permissionMessages: Record<string, string> = {
            admin: "Admin access denied to this thread",
            read: "Access denied to this thread",
            write: "Write access denied to this thread",
        };

        return throwUnauthorized(permissionMessages[requiredPermission]);
    }

    return { permission: result.permission, thread: result.thread as ThreadDoc };
};

/**
 * Gets an agent instance configured with the user's preferences (location, timezone, language, and personalization).
 * @param context The context (Query, Mutation, or Action)
 * @param userId The ID of the user to get preferences for
 * @param model The agent model to use
 * @param threadLanguage Optional thread-specific language (overrides user default)
 * @returns An agent instance configured with user preferences
 */
export const getAgentForUser = async (
    context: AnyThreadContext,
    userId: string,
    model: string,
    threadLanguage?: string,
): Promise<ReturnType<typeof getAgent>> => {
    const {
        aboutMe,
        customInstructions,
        language: userLanguage,
        location,
        nickname,
        profession,
        timezone,
    } = await context.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId });

    // Priority: thread language > user language
    const language = threadLanguage || userLanguage;

    // Build personalization object only if any personalization fields are set
    const personalization = nickname || profession || aboutMe || customInstructions ? { aboutMe, customInstructions, nickname, profession } : undefined;

    // The gateway binding exists only on an action's ctx; from a query or mutation
    // this agent can read and save messages but never generate.
    return await getAgent(model, { gateway: gatewayFetchFor(context), language, location, personalization, timezone });
};
