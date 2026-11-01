import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { leafRowOf } from "../../agent/agent-switch";
import { agentSwitchOf } from "../../agent/agent-switch-logic";
import type { ReattachFallbackReason } from "../../agent/agent-switch-validators";
import { walkPath } from "../../agent/branch-rows";
import { patchAgentSwitchRow } from "../../agent/table-writes";
import { omit } from "../../lib/collections";

type Session = Doc<"acpSessions">;

/** Rows looked at for the divider a session was opened for: it is the newest, the session was opened right after it. */
const SCAN_ROWS = 20;

/** The most UTF-8 bytes of an agent's own session id the computer's core accepts in a start (`acp_call.rs#NATIVE_ID_MAX`). */
export const NATIVE_ID_MAX_BYTES = 256;

/** Whether an id the agent reported can be asked for again: the core counts bytes, the validators count characters. */
export const nativeIdFits = (id: string): boolean => new TextEncoder().encode(id).length <= NATIVE_ID_MAX_BYTES;

/**
 * The saved session of the SAME agent a switch may ask the computer to load again (harness switch S4): the thread's NEWEST
 * earlier session with the same agent, folder and computer, when it recorded the agent's own session id and its report
 * said the agent loads saved sessions. The newest is the only candidate: an older one has missed whatever the newest
 * saw, and the catch-up a switch computes starts from the newest departure. Anything else — another folder, another
 * computer, a newest session that cannot load — is `undefined`, and the switch hands the conversation over instead
 * (`portable`), never reattaching. `sessions` are the thread's, newest first.
 */
export const savedSessionFor = (
    sessions: ReadonlyArray<Session>,
    target: { agentKey: string; deviceId: Id<"devices">; folderId: string },
): Session | undefined => {
    const newest = sessions.find((session) => session.deviceId === target.deviceId && session.agentKey === target.agentKey && session.folderId === target.folderId);

    return newest?.nativeSessionId !== undefined && nativeIdFits(newest.nativeSessionId) && isAvailable(capabilityOf(newest.capabilities, "sessions.load")) ? newest : undefined;
};

/**
 * Whether the agent a session was started for with a saved session id (`session.nativeSessionId`, recorded when the start
 * was queued) did NOT end up in that session, and why. A computer from before reattach ignores the id, opens a new
 * session and reports nothing about it, which reads the same as a failed load: only a reported `loaded: true` with the
 * id asked for is a reattach, so a load report without an id counts as a failed one.
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

    // A load nobody can match to the session asked for is not confirmed: without an id to compare, the agent may be in any session.
    if (open.nativeSessionId === undefined) {
        return "not_reattached";
    }

    return open.nativeSessionId === requestedNativeSessionId ? undefined : "other_session";
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
