/**
 * The broadest tool mode a run may use, from the organization the run is in (`org-policy.md` §6a).
 *
 * Every tool-assembling path reads it: the agent's tool set (`buildAgentTools`) and the MCP app proxy. A run with a
 * thread takes the thread's organization, so a run cannot pick a space by the caller's active organization. A policy
 * that cannot be read caps the run at `ask`; the cap is never dropped on a read error.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { toolsLogger } from "../../lib/logger";
import type { ToolPermissionMode } from "./tool-permissions";

/** The cap an organization's policy sets, `auto` for personal space (no organization). */
export const readPermissionCap = async (ctx: Pick<ActionCtx, "runQuery">, organizationId: string | null | undefined): Promise<ToolPermissionMode> => {
    if (!organizationId) {
        return "auto";
    }

    try {
        return await ctx.runQuery(internal.auth.organization_policy.getPermissionCapQuery, { organizationId });
    } catch (error: unknown) {
        toolsLogger.warn("[TOOLS] Organization permission cap unavailable; capping at ask:", error);

        return "ask";
    }
};

/**
 * The cap for a run. A run with a thread takes its thread's organization; a run without one (headless, group turns)
 * takes the organization its caller names. A thread that cannot be read caps the run at `ask`.
 */
export const readRunPermissionCap = async (
    ctx: Pick<ActionCtx, "runQuery">,
    { organizationId, threadId }: { organizationId: string | null | undefined; threadId: string | undefined },
): Promise<ToolPermissionMode> => {
    if (threadId === undefined) {
        return await readPermissionCap(ctx, organizationId);
    }

    try {
        const thread = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> });

        // A run whose thread cannot be found must not fall back to the personal space's `auto`.
        if (!thread) {
            toolsLogger.warn("[TOOLS] Run thread not found for its permission cap; capping at ask.");

            return "ask";
        }

        // A thread's stored organization wins. A thread that has none (created before the stamp, or by a path that
        // does not write one) takes the organization its run was started from, so it is never uncapped by default.
        return await readPermissionCap(ctx, thread.organizationId ?? organizationId);
    } catch (error: unknown) {
        toolsLogger.warn("[TOOLS] Run thread unavailable for its permission cap; capping at ask:", error);

        return "ask";
    }
};

/**
 * The cap for a request with no thread (the MCP app proxy). An HTTP action does not load the session, so the active
 * organization is read the way `/chat/start` reads it: from the caller's session. A failed read caps at `ask`, and
 * so does a signed-in caller whose identity names no session (a bearer minted before it carried `sid`): its space
 * cannot be told, so it must not read as the personal space.
 */
export const readRequestPermissionCap = async (ctx: Pick<HttpActionCtx, "auth" | "runQuery">, userId: string): Promise<ToolPermissionMode> => {
    try {
        const identity = await ctx.auth.getIdentity();
        const sessionId = identity?.sessionId;

        if (typeof sessionId !== "string") {
            if (identity) {
                toolsLogger.warn("[TOOLS] Request identity names no session; capping at ask.");

                return "ask";
            }

            return await readPermissionCap(ctx, null);
        }

        const session = await ctx.runQuery(internal.auth.session_organization.getSessionOrganizationForCap, { sessionId, userId });

        // A token whose session is gone or expired cannot be placed in a space either.
        if (!session) {
            toolsLogger.warn("[TOOLS] Request session cannot be validated; capping at ask.");

            return "ask";
        }

        return await readPermissionCap(ctx, session.organizationId);
    } catch (error: unknown) {
        toolsLogger.warn("[TOOLS] Request organization unavailable; capping at ask:", error);

        return "ask";
    }
};
