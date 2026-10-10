/**
 * Audit Log Functions
 *
 * Functions for logging and querying admin actions.
 * All admin actions should be logged for accountability.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { adminQuery } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

/**
 * Audit action types as a Zod enum for validation.
 */
export const AuditActionSchema = v.union(
    // User management
    v.literal("user.create"),
    v.literal("user.update"),
    v.literal("user.delete"),
    v.literal("user.role.update"),
    v.literal("user.ban"),
    v.literal("user.unban"),
    v.literal("user.sessions.revoke"),
    v.literal("user.impersonate.start"),
    v.literal("user.impersonate.stop"),
    // Admin actions
    v.literal("admin.grant"),
    v.literal("admin.revoke"),
    // Authentication events
    v.literal("auth.login"),
    v.literal("auth.logout"),
    v.literal("auth.password.reset.request"),
    v.literal("auth.password.reset.complete"),
    v.literal("auth.email.verify"),
    v.literal("auth.two-factor.enable"),
    v.literal("auth.two-factor.disable"),
    v.literal("auth.account.link"),
    v.literal("auth.account.unlink"),
    // Session management
    v.literal("session.create"),
    v.literal("session.update"),
    v.literal("session.delete"),
    // Organization actions
    v.literal("organization.create"),
    v.literal("organization.update"),
    v.literal("organization.delete"),
    v.literal("organization.member.add"),
    v.literal("organization.member.remove"),
    v.literal("organization.member.role.update"),
    v.literal("organization.invitation.send"),
    v.literal("organization.invitation.accept"),
    v.literal("organization.invitation.revoke"),
    // Team actions
    v.literal("team.create"),
    v.literal("team.update"),
    v.literal("team.delete"),
    v.literal("team.member.add"),
    v.literal("team.member.remove"),
);

export type AuditAction = Infer<typeof AuditActionSchema>;

/**
 * A context that can write.
 *
 * Was `{ orm: MutationContext["orm"] }` — a Drizzle-style ORM, which Lunora
 * does not have. Structural rather than `MutationCtx` for the same reason it was
 * before: this is called from cRPC middleware contexts as well as plain
 * mutations, and those do not share a nominal type.
 */
type WritableContext = {
    db: { insert: (table: "auditLog", values: Record<string, unknown>) => Promise<unknown> };
};

/**
 * Internal helper to create an audit log entry.
 * Called from admin functions after performing actions.
 * @param ctx Any context with orm capability (mutation or cRPC mutation context)
 * @param params Audit log entry details
 */
export const createAuditLogEntry = async (
    ctx: WritableContext,
    params: {
        action: AuditAction;
        adminEmail: string;
        adminId: string;
        details?: Record<string, unknown>;
        ipAddress?: string;
        targetUserEmail?: string;
        targetUserId?: string;
    },
) => {
    await ctx.db.insert("auditLog", {
        action: params.action,
        adminEmail: params.adminEmail,
        adminId: params.adminId,
        details: params.details ? JSON.stringify(params.details) : undefined,
        ipAddress: params.ipAddress,
        targetUserEmail: params.targetUserEmail,
        targetUserId: params.targetUserId,
        timestamp: Date.now(),
    });
};

/**
 * Audit log entry schema for output.
 */
const AuditLogEntrySchema = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    action: AuditActionSchema,
    adminEmail: v.string(),
    adminId: v.string(),
    details: v.optional(v.union(v.string(), v.null())),
    ipAddress: v.optional(v.union(v.string(), v.null())),
    targetUserEmail: v.optional(v.union(v.string(), v.null())),
    targetUserId: v.optional(v.union(v.string(), v.null())),
    timestamp: v.number(),
});

/**
 * Get audit logs with pagination and filtering.
 */
export const getAuditLogs = adminQuery
    .input({
        action: v.optional(v.from(AuditActionSchema)),
        adminId: v.optional(v.string().max(MAX_LENGTH.id)),
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        // The bound is applied in the handler, and stays there. Codegen sees
        // through `v.from` since cli@176, so the original reason is gone —
        // but moving the bound to the boundary would change behaviour, not just
        // location: the handler CLAMPS with `Math.min(100, Math.max(1, …))`,
        // whereas a boundary check REJECTS. `limit: 500` would go from returning
        // 100 rows to a validation error for every existing caller.
        limit: v.optional(v.number()),
        targetUserId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(
        v.from(
            v.object({
                continueCursor: v.optional(v.union(v.string(), v.null())),
                isDone: v.boolean(),
                logs: v.array(AuditLogEntrySchema),
            }),
        ),
    )
    .query(async ({ args: input, ctx }) => {
        const paginationOptions = {
            cursor: input.cursor ?? null,
            numItems: Math.min(100, Math.max(1, input.limit ?? 50)),
        };

        // Every filter goes into one `where`, rather than picking a single index
        // and sieving the rest out of the returned page in JS. Two consequences,
        // both intended: a page now comes back at its requested size instead of
        // shrinking as post-filtering discards rows, and `targetUserId` combined
        // with `action` (without `adminId`) is actually applied — the old
        // if/else-if chain indexed on the first match and dropped the rest.
        const result = await ctx.db.auditLog.findMany({
            cursor: paginationOptions.cursor,
            limit: paginationOptions.numItems,
            orderBy: [{ timestamp: "desc" }],
            where: {
                ...(input.adminId && { adminId: input.adminId }),
                ...(input.targetUserId && { targetUserId: input.targetUserId }),
                ...(input.action && { action: input.action }),
            },
        });

        const logs = result.page;

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            logs: logs.map((log) => {
                return {
                    ...log,
                    action: log.action as AuditAction,
                };
            }),
        };
    });

/**
 * Get audit log entry by ID.
 */
export const getAuditLogEntry = adminQuery
    .input({
        logId: v.id("auditLog"),
    })
    .output(v.from(v.union(AuditLogEntrySchema, v.null())))
    .query(async ({ args: input, ctx }) => {
        const log = await ctx.db.auditLog.findFirst({ where: { _id: input.logId } });

        if (!log) {
            return null;
        }

        return {
            ...log,
            action: log.action as AuditAction,
        };
    });

/**
 * Get audit log statistics for dashboard.
 */
export const getAuditLogStats = adminQuery
    .input({ now: v.number() })
    .output(
        v.from(
            v.object({
                actionCounts: v.array(
                    v.object({
                        action: AuditActionSchema,
                        count: v.number(),
                    }),
                ),
                last7Days: v.number(),
                last24Hours: v.number(),
                totalLogs: v.number(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const { now } = args;
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

        // Counted in the database rather than by materialising rows and reading
        // `.length`: a capped read reports the cap once the window exceeds it, so
        // the dashboard would flatten out at a round number instead of growing.
        const [last24Hours, last7Days, actionTotals] = await Promise.all([
            ctx.db.auditLog.count({ timestamp: { gte: oneDayAgo } }),
            ctx.db.auditLog.count({ timestamp: { gte: sevenDaysAgo } }),
            ctx.db.auditLog.groupBy({ by: ["action"], where: { timestamp: { gte: sevenDaysAgo } } }),
        ]);

        const actionCounts = actionTotals.map((entry) => {
            return {
                action: entry.key.action as AuditAction,
                count: entry.value ?? 0,
            };
        });

        return {
            actionCounts,
            last7Days,
            last24Hours,
            totalLogs: last7Days,
        };
    });
