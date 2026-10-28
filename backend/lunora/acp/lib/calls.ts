/**
 * What a coding-agent command's end means for the thread (plans/acp-agent-host.md §4.1, §4.6), whichever way the
 * call ends: the desktop's signed result, its refusal to run the call, the claim window closing, or the deadline.
 *
 * - `acp_send` accepted: the host holds the prompt, so the turn is `received` (forward only; the host's own
 *   `turn_start` says the same).
 * - `acp_send` refused or never answered: the turn never reached the agent. The stream ends as failed with the
 *   reason, so no client keeps a "Sending" turn that nothing will carry out. A turn the host already acknowledged is
 *   its own to end, and is left alone.
 * - `acp_start` refused or never answered: the session never opened, so it ends.
 *
 * And the prompt is cleared. A device call keeps its text in `input` and in its signed `envelope`, and the audit
 * list previews `input` for 30 days; the thread keeps the text as the user's message, and the desktop has the
 * envelope by the time the call ends.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { MutationCtx } from "../../_generated/server";
import { isForwardHostState, updateHostStream } from "../../chat/streaming/persistent/host";
import { isAcpTool } from "../../devices/lib/state";
import { START_GRACE_MS } from "./constants";
import { finishHostTurn } from "./finish";

type Call = Doc<"deviceCalls">;

export type AcpCallEnd = { error?: string; status: "completed" | "denied" | "expired" | "failed" };

export const HOST_DID_NOT_ANSWER = "host did not answer";

const inputOf = (call: Call): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(call.input);

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

const REFUSAL_PREFIX = /^(The device refused the request|refused): ?/u;

/** The words a thread shows for a command that was not carried out. */
const reasonOf = (end: AcpCallEnd): string => {
    if (end.status === "expired") {
        return "The host did not answer.";
    }

    const reason = (end.error ?? "").replace(REFUSAL_PREFIX, "").trim();

    return reason === "" ? "The host did not carry out the message." : `The host did not carry out the message: ${reason.slice(0, 300)}.`;
};

export const SESSION_NEVER_OPENED = "The agent did not start, so the message was not sent.";

/**
 * A session still waiting for its agent to open ends, and so does a message held for it (`acp_send` is accepted
 * while the session is `starting`): its stream fails with the reason instead of waiting for the reaper. One that
 * opened meanwhile is left alone.
 */
export const endStartingSession = async (ctx: MutationCtx, deviceId: Id<"devices">, hostSessionId: string, now: number): Promise<void> => {
    const session = await ctx.db.acpSessions.findFirst({ where: { deviceId, hostSessionId } });

    if (session?.status !== "starting") {
        return;
    }

    await ctx.db.patch(session._id, { status: "ended", updatedAt: now });

    const held = await ctx.db.persistentStreams.findFirst({
        orderBy: [{ _creationTime: "desc" }],
        where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId: session.threadId },
    });

    if (held) {
        await finishHostTurn(ctx, held, { error: SESSION_NEVER_OPENED, reason: "failed" }, now);
    }
};

/**
 * Run with the call as it was BEFORE its terminal write, since the effects read the prompt's ids from `input`.
 * Does nothing for a device tool.
 */
export const onAcpCallEnded = async (ctx: MutationCtx, call: Call, end: AcpCallEnd, now: number): Promise<void> => {
    if (!isAcpTool(call.toolName)) {
        return;
    }

    const input = inputOf(call);

    if (call.toolName === "acp_send" && typeof input.turnId === "string") {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: input.turnId } });

        if (!stream) {
            return;
        }

        if (end.status === "completed") {
            if (isForwardHostState(stream.hostState, "received") && stream.status === "pending") {
                await updateHostStream(ctx, stream, { hostState: "received", streaming: false });
            }
        } else if (stream.hostState === "accepted") {
            await finishHostTurn(ctx, stream, { error: reasonOf(end), reason: "failed" }, now);
        }

        return;
    }

    if (call.toolName === "acp_start" && typeof input.sessionId === "string") {
        if (end.status === "completed") {
            await ctx.scheduler.runAfter(START_GRACE_MS, internal.acp.calls.endUnopenedSession, { deviceId: call.deviceId, hostSessionId: input.sessionId });

            return;
        }

        await endStartingSession(ctx, call.deviceId, input.sessionId, now);
    }
};
