import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { SESSION_TOUCH_MS } from "./constants";

type Session = Doc<"acpSessions">;
type SessionStatus = Session["status"];

/** The session a host thread runs in. A host thread has exactly one (`session_open` makes both). */
export const sessionOfThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<Session | null> =>
    await ctx.db.acpSessions.findFirst({ where: { threadId } });

/** Writes the session only when something it shows changed; `lastEventAt` moves at most every {@link SESSION_TOUCH_MS}. */
export const touchSession = async (ctx: Pick<MutationCtx, "db">, session: Session, status: SessionStatus | undefined, now: number): Promise<void> => {
    const statusChanged = status !== undefined && status !== session.status && session.status !== "ended";
    const stale = session.lastEventAt === undefined || now - session.lastEventAt >= SESSION_TOUCH_MS;

    if (!statusChanged && !stale) {
        return;
    }

    await ctx.db.patch(session._id, { lastEventAt: now, updatedAt: now, ...(statusChanged && { status }) });
};
