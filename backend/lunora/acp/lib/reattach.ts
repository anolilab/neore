import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { leafRowOf } from "../../agent/agent-switch";
import { agentSwitchOf } from "../../agent/agent-switch-logic";
import { walkPath } from "../../agent/branch-rows";
import { patchAgentSwitchRow } from "../../agent/table-writes";

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
 * The computer opened a session it was asked to resume, and could not load it: the divider that asked is now a `portable`
 * handoff with the reason, so the transcript says what happened and the agent's first prompt carries the handoff
 * (`acp/lib/pending-handoff.ts`). A divider that is not a `native` one, or that already has a reason, is left alone.
 */
export const markReattachFailed = async (ctx: MutationCtx, threadId: Id<"threads">, reason: string): Promise<void> => {
    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
    const leaf = thread && (await leafRowOf(ctx as unknown as QueryCtx, thread));

    if (!leaf) {
        return;
    }

    const { rows } = await walkPath(ctx as unknown as QueryCtx, threadId, leaf, { limit: SCAN_ROWS });

    for (const row of rows) {
        const part = agentSwitchOf(row);

        if (part) {
            if (part.mode === "native" && part.fallbackReason === undefined) {
                await patchAgentSwitchRow(ctx.db, row._id, { ...part, fallbackReason: reason.slice(0, 500), mode: "portable" });
            }

            return;
        }
    }
};
