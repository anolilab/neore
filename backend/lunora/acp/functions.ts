/**
 * Coding-agent sessions, as the web app reads them. Both are the caller's own; a host thread is never shared.
 * Starting, cancelling and answering are the remote-control slice (plans/acp-agent-host.md §8, S4).
 */
import { CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES, unknownCapabilityReport } from "@neore/ai/capabilities";
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { isLocalBrowserModel, loadCustomProviders } from "../chat/lib/local-turn";
import { authQuery } from "../lib/crpc";
import { vCapabilityReport } from "../lib/capability-report";
import { MAX_LENGTH } from "../lib/validators";
import { isHostRunThread } from "./lib/host-thread";
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

/**
 * What the runner of a thread can do (plans/provider-capabilities.md §6): the report its host sent for a host
 * thread (all unknown while it has sent none), the local-browser declaration for a thread on one of the owner's
 * `local-browser` endpoints, the cloud declaration for any other. Null for a thread the caller cannot read, so a
 * stranger learns nothing, not even that the id exists.
 *
 * A local-browser thread is told by its model's endpoint TYPE (`custom:<endpoint>/<model>` against the owner's
 * endpoints), never by a model name. Only the owner's endpoints are readable here, so a grantee reads the cloud
 * declaration for it; the composer that runs a local model picks `LOCAL_BROWSER_CAPABILITIES` itself.
 */
export const getThreadCapabilities = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), vCapabilityReport))
    .query(async ({ args, ctx }) => {
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const access = threadId ? await resolveThreadReadAccess(ctx, threadId, ctx.user.userId) : null;

        if (access?.kind !== "full") {
            return null;
        }

        if (!isHostRunThread(access.thread)) {
            const onLocalEndpoint =
                access.thread.userId === ctx.user.userId && isLocalBrowserModel(access.thread.model, await loadCustomProviders(ctx, ctx.user.userId));

            return onLocalEndpoint ? LOCAL_BROWSER_CAPABILITIES : CLOUD_INTERACTIVE_CAPABILITIES;
        }

        const session = await ctx.db.acpSessions.findFirst({ where: { threadId: access.thread._id, userId: ctx.user.userId } });

        return session?.capabilities ?? unknownCapabilityReport(0);
    });
