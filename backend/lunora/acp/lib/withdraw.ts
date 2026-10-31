/**
 * Coding-agent commands that must not be delivered once the turn they belong to is over. Expiring the call is what
 * stops it: a host that comes back finds nothing pending to claim.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { patchDeviceCall } from "../../devices/lib/call-writes";
import { ACP_CLEARED } from "./constants";
import { sessionOfThread } from "./sessions";

type Call = Doc<"deviceCalls">;
type Stream = Doc<"persistentStreams">;

const turnIdOf = (call: Call): string | undefined => {
    try {
        const parsed = JSON.parse(call.input) as { turnId?: unknown };

        return typeof parsed.turnId === "string" ? parsed.turnId : undefined;
    } catch {
        return undefined;
    }
};

const withdraw = async (ctx: MutationCtx, stream: Stream, now: number, reason: string, matches: (call: Call) => boolean): Promise<void> => {
    const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

    if (!session) {
        return;
    }

    for (const status of ["pending", "claimed"] as const) {
        const { page } = await ctx.db.deviceCalls.findMany({ limit: 50, where: { deviceId: session.deviceId, status } });

        for (const call of page) {
            if (matches(call)) {
                await patchDeviceCall(ctx, call._id, { completedAt: now, error: reason, status: "expired", ...ACP_CLEARED });
            }
        }
    }
};

/** A prompt the computer has not acknowledged does not run after the person pressed Stop. */
export const withdrawSend = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    await withdraw(ctx, stream, now, "Stopped", (call) => call.toolName === "acp_send" && turnIdOf(call) === stream.hostTurnId);
};

/**
 * Answers still on their way when the turn ends. Delivered later they would allow a step of a turn that is over,
 * and an agent that is still running it (a lost cancel) would carry on with it.
 */
export const withdrawPermissionAnswers = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    await withdraw(ctx, stream, now, "The turn ended", (call) => call.toolName === "acp_permission_answer" && call.threadId === stream.threadId);
};
