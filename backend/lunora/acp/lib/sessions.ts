import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { SESSION_TOUCH_MS } from "./constants";

type Session = Doc<"acpSessions">;
type SessionStatus = Session["status"];

/**
 * The session a host thread runs in now: its newest. A thread has one when it is made (`session_open`), and a switch
 * to another host agent in the same thread (plans/harness-switch.md, S3) ends it and opens the next, so a thread's
 * earlier sessions stay as `ended` rows and only the newest can be written into.
 */
export const sessionOfThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<Session | null> =>
    await ctx.db.acpSessions.findFirst({ orderBy: [{ _creationTime: "desc" }], where: { threadId } });

/**
 * Writes the session only when something it shows changed; `lastEventAt` moves at most every {@link SESSION_TOUCH_MS}.
 * A `starting` session is left `starting`: only its agent opening it (`session_open`) or the start failing leaves
 * that state, and a message held for it (plans/acp-agent-host.md §4.6) must not skip either.
 */
export const touchSession = async (ctx: Pick<MutationCtx, "db">, session: Session, status: SessionStatus | undefined, now: number): Promise<void> => {
    const statusChanged = status !== undefined && status !== session.status && session.status !== "ended" && session.status !== "starting";
    const stale = session.lastEventAt === undefined || now - session.lastEventAt >= SESSION_TOUCH_MS;

    if (!statusChanged && !stale) {
        return;
    }

    await ctx.db.patch(session._id, { lastEventAt: now, updatedAt: now, ...(statusChanged && { status }) });
};
