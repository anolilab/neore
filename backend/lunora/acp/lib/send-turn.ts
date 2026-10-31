import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { createHostStream } from "../../chat/streaming/persistent/host";
import { createAcpCall, type AcpCallResult } from "../../devices/lib/acp-call";
import type { DeviceTaintSource } from "../../devices/lib/taint";
import { touchSession } from "./sessions";

/**
 * Queues one prompt for a host thread's agent (plans/acp-agent-host.md §4.6): the signed `acp_send`, the prompt as
 * the user's message and the stream the turn will write (`accepted`), in the caller's transaction. Shared by
 * `/hosts/send` and a host worker's dispatch, so a worker's prompt travels the same signed path and nothing is
 * signed or ingested a second way. The caller has already decided the thread may take a turn now (one at a time).
 *
 * The call is created first: when it is refused (`busy`, `offline`, `ineligible`, `input_too_large`) nothing was written.
 */
export const queueHostTurn = async (
    ctx: MutationCtx,
    args: {
        session: Doc<"acpSessions">;
        /** Untrusted content the text carries; signed into the call so the computer never offers "Always allow" for the turn. */
        taintedBy?: ReadonlyArray<DeviceTaintSource>;
        text: string;
        threadId: Id<"threads">;
        userId: string;
    },
    now: number,
): Promise<{ error: Extract<AcpCallResult, { error: string }>["error"] } | { messageId: string; streamId: Id<"persistentStreams">; turnId: string }> => {
    const { session, taintedBy, text, threadId, userId } = args;
    const turnId = crypto.randomUUID();
    const call = await createAcpCall(
        ctx,
        { deviceId: session.deviceId, input: { sessionId: session.hostSessionId, text, turnId }, kind: "acp_send", taintedBy, threadId, userId },
        now,
    );

    if ("error" in call) {
        return { error: call.error };
    }

    const { messages } = await addMessagesHandler(ctx, {
        fromUser: true,
        messages: [{ message: { content: text, role: "user" }, status: "success" }],
        threadId,
        userId,
    });
    const prompt = messages[0];

    if (!prompt) {
        throw new LunoraError("INTERNAL", "The prompt was not saved");
    }

    const streamId = await createHostStream(ctx, { hostState: "accepted", messageId: prompt._id, threadId, turnId, userId }, now);

    // A session still `starting` stays so (`touchSession`): the computer holds the message until the agent opens it.
    await touchSession(ctx, session, "busy", now);

    return { messageId: prompt._id as string, streamId, turnId };
};
