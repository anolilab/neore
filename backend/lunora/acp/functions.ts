/**
 * Coding-agent sessions, as the web app reads them. Both are the caller's own; a host thread is never shared.
 * Starting, cancelling and answering are the remote-control slice (plans/acp-agent-host.md §8, S4).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { authQuery } from "../lib/crpc";
import { vCapabilityReport } from "../lib/capability-report";
import { MAX_LENGTH } from "../lib/validators";
import { vAcpSessionStatus } from "./validators";

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
    .output(v.union(v.null(), vHostSessionView))
    .query(async ({ args, ctx }) => {
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const row = threadId ? await ctx.db.acpSessions.findFirst({ where: { threadId, userId: ctx.user.userId } }) : null;

        return row ? toView(row) : null;
    });
