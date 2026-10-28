/**
 * Coding-agent sessions, as the web app reads them. Both are the caller's own; a host thread is never shared.
 * Starting, cancelling and answering are in `remote.ts`.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { authQuery } from "../lib/crpc";
import { vCapabilityReport } from "../lib/capability-report";
import { MAX_LENGTH } from "../lib/validators";
import { vAcpSessionStatus, vHostEndReason } from "./validators";

const MAX_LISTED_SESSIONS = 50;

const vHostSessionView = v.object({
    _id: v.string(),
    agentKey: v.string(),
    agentLabel: v.string(),
    capabilities: v.optional(vCapabilityReport),
    createdAt: v.number(),
    deviceId: v.string(),
    folderLabel: v.string(),
    lastEventAt: v.optional(v.number()),
    status: vAcpSessionStatus,
    threadId: v.string(),
});

/**
 * One session with how its last turn ended, so Continue is offered after a restart or a timeout
 * (plans/acp-agent-host.md §4.5). Read off the last STREAM, not the reply row: a restart that comes after the
 * reaper moves the reason from `timeout` to `interrupted` and writes no second reply.
 */
const vHostSessionDetail = v.object({
    _id: v.string(),
    agentKey: v.string(),
    agentLabel: v.string(),
    capabilities: v.optional(vCapabilityReport),
    createdAt: v.number(),
    deviceId: v.string(),
    folderLabel: v.string(),
    lastEndReason: v.optional(vHostEndReason),
    lastEventAt: v.optional(v.number()),
    status: vAcpSessionStatus,
    threadId: v.string(),
});

const toView = (row: {
    _id: unknown;
    agentKey: string;
    agentLabel: string;
    capabilities?: Infer<typeof vCapabilityReport>;
    createdAt: number;
    deviceId: unknown;
    folderLabel: string;
    lastEventAt?: number;
    status: Infer<typeof vAcpSessionStatus>;
    threadId: unknown;
}): Infer<typeof vHostSessionView> => {
    return {
        _id: row._id as string,
        agentKey: row.agentKey,
        agentLabel: row.agentLabel,
        createdAt: row.createdAt,
        deviceId: row.deviceId as string,
        folderLabel: row.folderLabel,
        status: row.status,
        threadId: row.threadId as string,
        ...(row.capabilities !== undefined && { capabilities: row.capabilities }),
        ...(row.lastEventAt !== undefined && { lastEventAt: row.lastEventAt }),
    };
};

/** The thread is gone for good: so is the session that ran or imported into it, or its agent session could never be imported again. */
export const deleteSessionsOfThread = internalMutation
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const { page } = threadId ? await ctx.db.acpSessions.findMany({ where: { threadId } }) : { page: [] };

        for (const session of page) {
            await ctx.db.delete(session._id);
        }

        return null;
    });

/** The caller's coding-agent sessions, newest first. */
export const listHostSessions = authQuery
    .input({})
    .output(v.array(vHostSessionView))
    .query(async ({ ctx }) => {
        const { page } = await ctx.db.acpSessions.findMany({
            limit: MAX_LISTED_SESSIONS,
            orderBy: [{ createdAt: "desc" }],
            where: { userId: ctx.user.userId },
        });

        return page.map((row) => toView(row));
    });

/** The session a host thread runs in, or null for a thread that is not one, or is not the caller's. */
export const getHostSession = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), vHostSessionDetail))
    .query(async ({ args, ctx }) => {
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const row = threadId ? await ctx.db.acpSessions.findFirst({ where: { threadId, userId: ctx.user.userId } }) : null;

        if (!row || !threadId) {
            return null;
        }

        const last = await ctx.db.persistentStreams.findFirst({ orderBy: [{ _creationTime: "desc" }], where: { producer: "host", threadId } });

        return { ...toView(row), ...(last?.hostEndReason !== undefined && { lastEndReason: last.hostEndReason }) };
    });
