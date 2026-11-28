import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { leafRowOf } from "../../agent/agent-switch";
import { composeHandoff, composeTailHandoff, HandoffTooLargeError, jsonBytes } from "../../agent/handoff";
import { collectHandoffSource } from "../../agent/handoff-source";
import { insertAgentSwitchRow, patchAgentSwitchRow, patchThread } from "../../agent/table-writes";

/** The most the summary carried into a fresh session may weigh, in UTF-8 bytes as a signed call carries it: a short note, not the whole conversation. */
export const FORK_HANDOFF_MAX_BYTES = 6 * 1024;

/**
 * A fork whose agent could not fork its session (`fork_unsupported`, `fork_failed`) opened a FRESH session: it holds none of the copied
 * history. This marks that in the new chat, and carries what came before into the session:
 *
 * - a `portable` divider after the copied history, the marker a person sees where the agent started fresh and was handed the conversation;
 * - the summary as its handoff, which the session's first turn carries in front of the prompt (`pending-handoff.ts`). It is built from the
 *   chat's own rows, which are the copied SETTLED messages and nothing else (never host text), as the newest whole turns that fit
 *   {@link FORK_HANDOFF_MAX_BYTES}, with a line saying how many earlier ones are left out.
 *
 * The chat is marked as handed over (`hasHandoff`), as any chat that takes over from another agent is. Does nothing for a chat with no
 * copied history, one already marked (a report sent twice), or one deleted.
 */
export const markForkFellBack = async (ctx: MutationCtx, session: Doc<"acpSessions">): Promise<void> => {
    const thread = await ctx.db.threads.findFirst({ where: { _id: session.threadId } });

    if (!thread || thread.deleted === true) {
        return;
    }

    const leaf = await leafRowOf(ctx, thread);

    // A divider as the leaf (a native switch copied in) does not end the fallback: the fresh session still needs the handoff after it.
    if (!leaf) {
        return;
    }

    const source = await collectHandoffSource(ctx, thread._id, leaf);

    if (source.turns.length === 0) {
        return;
    }

    let handoff: string;

    try {
        handoff = composeTailHandoff(source.turns, FORK_HANDOFF_MAX_BYTES, source.omittedEarlier);
    } catch (error) {
        if (!(error instanceof HandoffTooLargeError)) {
            throw error;
        }

        // The newest turn alone is over the cap: the note says earlier turns are not included.
        handoff = composeHandoff({ kind: "portable", omittedTurns: 0, tail: [] });
    }

    // Never dropped for its size: the divider and a note that earlier turns are not included still go in, so the chat says it started fresh.
    if (jsonBytes(handoff) > FORK_HANDOFF_MAX_BYTES) {
        handoff = composeHandoff({ kind: "portable", omittedTurns: 0, tail: [] });
    }

    const agent = {
        agentKey: session.agentKey,
        agentLabel: session.agentLabel,
        folderId: session.folderId,
        folderLabel: session.folderLabel,
        hostId: session.deviceId as string,
        kind: "host" as const,
    };
    const part = { from: agent, handoff, mode: "portable" as const, to: agent };
    const dividerId = await insertAgentSwitchRow(ctx.db, {
        order: leaf.order + 1,
        parentMessageId: leaf._id,
        part: { ...part, startMessageId: "first" },
        threadId: thread._id,
        userId: session.userId,
    });

    await patchAgentSwitchRow(ctx.db, dividerId, { ...part, startMessageId: dividerId });
    await patchThread(ctx.db, thread._id, { hasHandoff: true });
};
