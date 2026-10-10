import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { getSession } from "../auth/session";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { EXPORT_EXPIRY_MS } from "./constants";
import { assertAccountDeletionAllowed } from "./deletion-guard";
import { withoutUndefined } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
import { noteShardActivity } from "../lib/shard-housekeeping";
import { withDependency } from "../lib/dependency";

export const getExportStatus = authQuery.query(async ({ ctx }) => {
    const { userId } = ctx.user;

    const request = await ctx.db
        .query("gdprRequests")
        .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "export"))
        .order("desc")
        .first();

    return request
        ? {
              _creationTime: request._creationTime,
              _id: request._id,
              completedAt: request.completedAt,
              currentStep: request.currentStep,
              errorMessage: request.errorMessage,
              expiresAt: request.expiresAt,
              hasFile: !!request.storageId,
              progress: request.progress,
              requestedAt: request.requestedAt,
              requestType: request.requestType,
              status: request.status,
              userEmail: request.userEmail,
              userId: request.userId,
          }
        : null;
});

/** The five states a `gdprRequests` row can be in. */
const vGdprRequestStatus = v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"));

/**
 * Native `v.*`, not `v.from(zod)` — codegen infers the reference's return type
 * from the handler, and it cannot see through the zod wrapper, so the previous
 * validator generated `unknown`.
 *
 * The zod version carried `.passthrough()`, but the handler projects an explicit
 * field list (it does NOT spread the row), so nothing was passing through:
 * `downloadUrl`, `expiresAt`, `storageId` and `workflowId` are on the row and
 * deliberately absent from the response. Note this query — unlike its sibling
 * `getGdprStatus` — does NOT return `expiresAt`/`hasFile`.
 */
export const getDeletionStatus = authQuery
    .output(
        v.union(
            v.null(),
            v.object({
                _creationTime: v.number(),
                _id: v.id("gdprRequests"),
                completedAt: v.union(v.number(), v.null()),
                currentStep: v.union(v.string(), v.null()),
                errorMessage: v.union(v.string(), v.null()),
                progress: v.union(v.number(), v.null()),
                requestedAt: v.number(),
                requestType: v.literal("deletion"),
                status: vGdprRequestStatus,
                userEmail: v.string(),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;

        const request = await ctx.db
            .query("gdprRequests")
            .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "deletion"))
            .order("desc")
            .first();

        return request
            ? {
                  _creationTime: request._creationTime,
                  _id: request._id,
                  completedAt: request.completedAt ?? null,
                  currentStep: request.currentStep ?? null,
                  errorMessage: request.errorMessage ?? null,
                  progress: request.progress ?? null,
                  requestedAt: request.requestedAt,
                  requestType: "deletion" as const,
                  status: request.status,
                  userEmail: request.userEmail,
                  userId: request.userId,
              }
            : null;
    });

// `profile.createdAt` is the account's own creation time, read from its `user`
// row. The query returns no response-time value, so its result depends only on
// stored data.
export const getDataAccessSummary = authQuery
    .output(
        v.object({
            dataSummary: v.object({
                files: v.number(),
                gdprRequests: v.number(),
                hasSettings: v.boolean(),
                prompts: v.number(),
            }),
            profile: v.object({
                createdAt: v.number(),
                email: v.string(),
                emailVerified: v.boolean(),
                name: v.string(),
            }),
        }),
    )
    .query(async ({ ctx }) => {
        const { email: userEmail, name: username, userId } = ctx.user;

        // OPTIMIZED: Use .count() instead of .take(10000).length for 100x speedup
        const [filesCount, promptsCount, hasSettings] = await Promise.all([
            // The caller's own rows — what the owner policies admit; `count()` cannot run behind them.
            systemDb(ctx).files.count({ userId }),
            systemDb(ctx).prompts.count({ userId }),
            ctx.db
                .query("userSettings")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .first()
                .then((r) => !!r),
        ]);

        const gdprRequests = await ctx.db
            .query("gdprRequests")
            .withIndex("by_user_and_type", (q) => q.eq("userId", userId))
            .collect();

        const account = await ctx.db.user.findFirst({ where: { _id: ctx.db.asId("user", userId) } });

        if (!account) {
            throw new LunoraError("NOT_FOUND", "Account not found");
        }

        return {
            dataSummary: {
                files: filesCount,
                gdprRequests: gdprRequests.length,
                hasSettings,
                prompts: promptsCount,
            },
            profile: {
                createdAt: account.createdAt,
                email: userEmail ?? "",
                emailVerified: !!userEmail,
                name: username ?? "",
            },
        };
    });

/**
 * One side of `getGdprStatus`, parameterised by which request kind it describes
 * so the `requestType` literal stays correlated with the key it hangs off —
 * `deletion` is never `"export"` and vice versa.
 *
 * This is `getDeletionStatus`'s shape PLUS `expiresAt` and `hasFile`; the two
 * queries project different subsets of the same row and always have.
 * `hasFile` is `!!row.storageId` — the storage id itself is never sent.
 */
const vGdprRequestSummary = <T extends "deletion" | "export">(requestType: T) =>
    v.object({
        _creationTime: v.number(),
        _id: v.id("gdprRequests"),
        completedAt: v.union(v.number(), v.null()),
        currentStep: v.union(v.string(), v.null()),
        errorMessage: v.union(v.string(), v.null()),
        expiresAt: v.union(v.number(), v.null()),
        hasFile: v.boolean(),
        progress: v.union(v.number(), v.null()),
        requestedAt: v.number(),
        requestType: v.literal(requestType),
        status: vGdprRequestStatus,
        userEmail: v.string(),
        userId: v.string(),
    });

export const getGdprStatus = authQuery
    .output(
        v.from(
            v.object({
                deletion: v.union(v.null(), vGdprRequestSummary("deletion")),
                export: v.union(v.null(), vGdprRequestSummary("export")),
            }),
        ),
    )
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;

        const [exportRequest, deletionRequest] = await Promise.all([
            ctx.db
                .query("gdprRequests")
                .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "export"))
                .order("desc")
                .first(),
            ctx.db
                .query("gdprRequests")
                .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "deletion"))
                .order("desc")
                .first(),
        ]);

        const formatRequest = <T extends "export" | "deletion">(request: typeof exportRequest, type: T) =>
            request
                ? {
                      _creationTime: request._creationTime,
                      _id: request._id,
                      completedAt: request.completedAt ?? null,
                      currentStep: request.currentStep ?? null,
                      errorMessage: request.errorMessage ?? null,
                      expiresAt: request.expiresAt ?? null,
                      hasFile: !!request.storageId,
                      progress: request.progress ?? null,
                      requestedAt: request.requestedAt,
                      requestType: type,
                      status: request.status,
                      userEmail: request.userEmail,
                      userId: request.userId,
                  }
                : null;

        return {
            deletion: formatRequest(deletionRequest, "deletion"),
            export: formatRequest(exportRequest, "export"),
        };
    });

export const requestDataExport = authMutation.use(rateLimit("gdpr/request")).mutation(async ({ ctx }) => {
    const { userId } = ctx.user;
    const userEmail = ctx.user.email || "";

    const existingRequest = await ctx.db
        .query("gdprRequests")
        .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "export"))
        .order("desc")
        .first();

    if (existingRequest && (existingRequest.status === "pending" || existingRequest.status === "processing")) {
        throw new LunoraError("TOO_MANY_REQUESTS", "An export is already in progress");
    }

    // Create request record
    const requestId = await ctx.db.insert("gdprRequests", {
        requestedAt: ctx.now,
        requestType: "export",
        status: "pending",
        userEmail,
        userId,
    });

    // Its expiry and timeout are swept on this shard (`lib/shard-housekeeping.ts`).
    await noteShardActivity(ctx, userId);

    ctx.scheduler.runAfter(0, internal.gdpr.workflow_actions.startExportWorkflow, {
        requestId,
        userEmail,
        userId,
    });

    // Log audit (lightweight operation)
    await ctx.db.insert("gdprAuditLog", {
        action: "export_requested",
        details: JSON.stringify({ requestId }),
        performedBy: userId,
        timestamp: ctx.now,
        userId,
    });

    ctx.log.event("gdpr.request_data_export", { requestType: "export" });

    return { requestId };
});

export const requestAccountDeletion = authMutation.use(rateLimit("gdpr/request")).mutation(async ({ ctx }) => {
    const { userId } = ctx.user;

    // Fresh, non-impersonated session only — see `deletion-guard.ts`.
    assertAccountDeletionAllowed(await getSession(ctx));

    const userEmail = ctx.user.email || "";

    const existingRequest = await ctx.db
        .query("gdprRequests")
        .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "deletion"))
        .order("desc")
        .first();

    if (existingRequest && (existingRequest.status === "pending" || existingRequest.status === "processing")) {
        throw new LunoraError("TOO_MANY_REQUESTS", "A deletion request is already in progress");
    }

    const requestId = await ctx.db.insert("gdprRequests", {
        requestedAt: ctx.now,
        requestType: "deletion",
        status: "pending",
        userEmail,
        userId,
    });

    // Its expiry and timeout are swept on this shard (`lib/shard-housekeeping.ts`).
    await noteShardActivity(ctx, userId);

    ctx.scheduler.runAfter(0, internal.gdpr.workflow_actions.startDeletionWorkflow, {
        requestId,
        userEmail,
        userId,
    });

    await ctx.db.insert("gdprAuditLog", {
        action: "deletion_requested",
        details: JSON.stringify({ requestId }),
        performedBy: userId,
        timestamp: ctx.now,
        userId,
    });

    ctx.log.event("gdpr.request_account_deletion", { requestType: "deletion" });

    return { requestId };
});

export const getExportDownloadUrl = authAction
    .use(rateLimit("gdpr/request"))
    .output(v.object({ expiresAt: v.union(v.number(), v.null()), url: v.string() }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;

        const request = await ctx.runQuery(internal.gdpr.functions.getExportRequest, { userId });

        if (!request) {
            throw new LunoraError("NOT_FOUND", "No export request found");
        }

        if (request.status !== "completed") {
            throw new LunoraError("BAD_REQUEST", `Export is not ready (status: ${request.status}, step: ${request.currentStep || "unknown"})`);
        }

        if (!request.storageId) {
            throw new LunoraError("NOT_FOUND", "Export file was not generated. Please try requesting a new export.");
        }

        if (request.expiresAt && request.expiresAt < Date.now()) {
            throw new LunoraError("BAD_REQUEST", "Export has expired");
        }

        const storageId = request.storageId;
        const url = await withDependency("file storage", () => ctx.storage.getUrl(storageId));

        if (!url) {
            throw new LunoraError("INTERNAL_SERVER_ERROR", "Failed to generate download URL. Please try again.");
        }

        await ctx.runMutation(internal.gdpr.functions.logAudit, {
            action: "export_downloaded",
            details: JSON.stringify({ requestId: request._id }),
            performedBy: userId,
            userId,
        });

        ctx.log.event("gdpr.get_export_download_url", { hasExpiry: Boolean(request.expiresAt) });

        return { expiresAt: request.expiresAt ?? null, url };
    });

export const getExportRequest = internalQuery.input({ userId: v.string() }).query(
    async ({ args: { userId }, ctx: context }) =>
        await context.db
            .query("gdprRequests")
            .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "export"))
            .order("desc")
            .first(),
);

export const getRequestById = internalQuery
    .input({ requestId: v.id("gdprRequests") })
    .query(async ({ args: { requestId }, ctx: context }) => await context.db.get(requestId));

export const logAudit = internalMutation
    .input({
        action: v.string(),
        details: v.string(),
        performedBy: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        await context.db.insert("gdprAuditLog", {
            action: args.action,
            details: args.details,
            performedBy: args.performedBy,
            timestamp: context.now,
            userId: args.userId,
        });

        return null;
    });

export const cancelStuckExport = authMutation.use(rateLimit("gdpr/request")).mutation(async ({ ctx }) => {
    const { userId } = ctx.user;

    const request = await ctx.db
        .query("gdprRequests")
        .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "export"))
        .order("desc")
        .first();

    if (request && (request.status === "pending" || request.status === "processing")) {
        await ctx.db.patch(request._id, { status: "cancelled" });
        await ctx.db.insert("gdprAuditLog", {
            action: "export_cancelled",
            details: JSON.stringify({ action: "cancelled", requestId: request._id }),
            performedBy: userId,
            timestamp: ctx.now,
            userId,
        });

        ctx.log.event("gdpr.cancel_stuck_export", { cancelled: true });
    }
});

export const updateRequestProgress = internalMutation
    .input({
        currentStep: v.optional(v.string()),
        downloadUrl: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        progress: v.optional(v.number()),
        requestId: v.id("gdprRequests"),
        status: v.optional(v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"))),
        storageId: v.optional(v.id("_storage")),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const { requestId, ...updates } = args;
        const patch: Partial<Doc<"gdprRequests">> = {};

        if (updates.status !== undefined) {
            patch.status = updates.status;
        }

        if (updates.currentStep !== undefined) {
            patch.currentStep = updates.currentStep;
        }

        if (updates.progress !== undefined) {
            patch.progress = updates.progress;
        }

        if (updates.storageId !== undefined) {
            patch.storageId = updates.storageId;
        }

        if (updates.downloadUrl !== undefined) {
            patch.downloadUrl = updates.downloadUrl;
        }

        if (updates.errorMessage !== undefined) {
            patch.errorMessage = updates.errorMessage;
        }

        if (updates.status === "completed") {
            patch.completedAt = context.now;
            patch.expiresAt = context.now + EXPORT_EXPIRY_MS;
        }

        await context.db.patch(requestId, withoutUndefined(patch));

        return null;
    });
