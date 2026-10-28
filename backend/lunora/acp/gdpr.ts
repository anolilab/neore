/**
 * Coding-agent sessions in the GDPR export and account deletion. Wired into `gdpr/workflows/export-workflow.ts`
 * ("collect-acp-sessions") and `gdpr/workflows/deletion-workflow.ts` ("delete-user-acp-sessions"). The threads,
 * messages and streams of a host-run thread are the ordinary thread rows the other steps already erase.
 * Deletion follows the residual steps' contract: at most `BATCH` rows per call, `{ hasMore }` back, idempotent
 * on retry.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { vCapabilityReport } from "../lib/capability-report";
import { vAcpSessionStatus } from "./validators";

const BATCH = 200;

/** Sessions are few (one per host thread); this bounds the read anyway. */
const EXPORT_MAX = 5000;

export const collectAcpSessionsForExport = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            sessions: v.array(
                v.object({
                    agentKey: v.string(),
                    agentLabel: v.string(),
                    capabilities: v.optional(vCapabilityReport),
                    createdAt: v.number(),
                    folderLabel: v.string(),
                    lastEventAt: v.optional(v.number()),
                    status: vAcpSessionStatus,
                    threadId: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.acpSessions.findMany({ limit: EXPORT_MAX, orderBy: [{ createdAt: "desc" }], where: { userId } });

        return {
            // Labels and times only: no device id, no path ever reaches the backend.
            sessions: page.map(({ agentKey, agentLabel, capabilities, createdAt, folderLabel, lastEventAt, status, threadId }) => {
                return {
                    agentKey,
                    agentLabel,
                    createdAt,
                    folderLabel,
                    status,
                    threadId: threadId as string,
                    ...(capabilities !== undefined && { capabilities }),
                    ...(lastEventAt !== undefined && { lastEventAt }),
                };
            }),
        };
    });

export const deleteUserAcpSessions = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.acpSessions.findMany({ limit: BATCH, where: { userId } });

        await Promise.all(page.map(async (row) => await ctx.db.delete(row._id)));

        return { hasMore: page.length >= BATCH };
    });
