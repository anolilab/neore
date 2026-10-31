import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { leafRowOf } from "../../agent/agent-switch";
import { agentSwitchOf } from "../../agent/agent-switch-logic";
import { walkPath } from "../../agent/branch-rows";
import type { ReattachFallbackReason } from "../../agent/agent-switch-validators";
import { patchAgentSwitchRow } from "../../agent/table-writes";
import { omit } from "../../lib/collections";

type Session = Doc<"acpSessions">;

/** Rows looked at for the divider a session was opened for: it is the newest, the session was opened right after it. */
const SCAN_ROWS = 20;

/**
 * The saved session of the SAME agent a switch may ask the computer to load again (harness switch S4): one of the thread's
 * own earlier sessions with the same agent, folder and computer, that recorded the agent's own session id and whose
 * report said the agent loads saved sessions. Anything else — another folder, another computer, an agent that never said
 * it loads them — is `undefined`, and the switch hands the conversation over instead (`portable`), never reattaching.
 * `sessions` are the thread's, newest first.
 */
export const savedSessionFor = (
    sessions: ReadonlyArray<Session>,
    target: { agentKey: string; deviceId: Id<"devices">; folderId: string },
): Session | undefined =>
    sessions.find(
        (session) =>
            session.deviceId === target.deviceId &&
            session.agentKey === target.agentKey &&
            session.folderId === target.folderId &&
            session.nativeSessionId !== undefined &&
            isAvailable(capabilityOf(session.capabilities, "sessions.load")),
    );

/**
 * Whether the agent a session was started for with a saved session id (`session.nativeSessionId`, recorded when the start
 * was queued) did NOT end up in that session, and why. A computer from before reattach ignores the id, opens a new
 * session and reports nothing about it, which reads the same as a failed load: only a reported `loaded: true` under
 * the id asked for is a reattach.
 */
export const reattachFailureOf = (
    requestedNativeSessionId: string,
    open: { nativeSessionId?: string; reattach?: { loaded: boolean; reason?: string } },
): ReattachFallbackReason | undefined => {
    if (open.reattach === undefined) {
        return "not_reattached";
    }

    if (!open.reattach.loaded) {
        return open.reattach.reason === "load_unsupported" ? "load_unsupported" : "load_failed";
    }

    return open.nativeSessionId !== undefined && open.nativeSessionId !== requestedNativeSessionId ? "other_session" : undefined;
};

/**
 * The computer opened a session it was asked to resume, and could not load it: the divider that asked is now a `portable`
 * handoff with the reason, so the transcript says what happened and the agent's first prompt carries the handoff
 * (`acp/lib/pending-handoff.ts`). A divider that is not a `native` one, or that already has a reason, is left alone.
 */
export const markReattachFailed = async (ctx: MutationCtx, threadId: Id<"threads">, reason: ReattachFallbackReason): Promise<void> => {
    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
    const leaf = thread && (await leafRowOf(ctx, thread));

    if (!leaf) {
        return;
    }

    const { rows } = await walkPath(ctx, threadId, leaf, { limit: SCAN_ROWS });

    for (const row of rows) {
        const part = agentSwitchOf(row);

        if (part) {
            if (part.mode === "native" && part.fallbackReason === undefined) {
                // The portable handoff covers the whole conversation: what the agent was to be caught up on is part of it.
                await patchAgentSwitchRow(ctx.db, row._id, { ...omit(part, ["catchUp"]), fallbackReason: reason, mode: "portable" });
            }

            return;
        }
    }
};
