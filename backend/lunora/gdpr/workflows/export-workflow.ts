/**
 * GDPR data export.
 *
 * On `@lunora/workflow` — a real durable workflow over Cloudflare Workflows, not
 * the scheduler shim this file briefly used. Every `ctx.step.do(name, …)` is a
 * checkpoint: if the isolate dies between "collect files" and "generate export",
 * the retry resumes at "generate export" with the earlier results replayed from
 * the durable log rather than recollected.
 *
 * That matters here specifically. The collect steps are expensive reads over a
 * user's whole history, and `generateExportFile` writes to R2 — re-running the
 * whole thing on a transient failure would cost the reads again and risk a second
 * orphaned object.
 *
 * Step names are stable identifiers in the durable log. Renaming one makes
 * in-flight instances resume at the wrong place, so treat them as a contract.
 */
import type { WorkflowConfig } from "@lunora/workflow";
import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { onUserShard } from "../../lib/workflow-shard";
import { stepDedupId } from "./dedup-id";
import { collectAllGuides, collectAllPullRequestThreads, collectAllReviewDrafts } from "../../source-control/export-pages";
import { clearUsagePieces, collectUsageExport, UsageExportError, type UsageExportIo, type UsagePageSummary, usageObjectKey } from "../usage-export-steps";

export interface ExportParams {
    requestId: Id<"gdprRequests">;
    userEmail: string;
    userId: string;
}

/** The user-facing reason a failed export shows; never the raw error. */
export const exportFailureMessage = (error: unknown): string => {
    if (error instanceof UsageExportError && error.reason === "changed") {
        return "Your usage kept changing while the export was written; request the export again";
    }

    if (error instanceof UsageExportError && error.reason === "too-large") {
        return "Your usage history is too large to export in one file; contact support";
    }

    return error instanceof LunoraError && error.code === "PAYLOAD_TOO_LARGE"
        ? "Your export is larger than the 32 MB limit; contact support"
        : "Failed to generate export file";
};

export const dataExportWorkflowConfig: WorkflowConfig<ExportParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const { requestId, userEmail, userId } = context.params;
        // Scoped to this instance, so a fresh instance for the same request collects again.
        const scope = `${requestId}:${context.event.instanceId}`;

        /** Progress writes are deliberately NOT checkpointed — idempotent and cheap. */
        const progress = async (patch: {
            currentStep?: string;
            errorMessage?: string;
            progress?: number;
            status?: "cancelled" | "completed" | "failed" | "pending" | "processing";
            storageId?: Id<"_storage">;
        }): Promise<void> => {
            await context.run(internal.gdpr.functions.updateRequestProgress, { requestId, ...patch });
        };

        await progress({ currentStep: "collecting_profile", progress: 10, status: "processing" });
        const profile = await context.step.do(
            "collect-profile",
            async () => await context.run(internal.gdpr.steps.collectProfile, { userId }, { dedupId: stepDedupId(scope, "collect-profile") }),
        );

        await progress({ currentStep: "collecting_settings", progress: 20 });
        const settings = await context.step.do(
            "collect-settings",
            async () => await context.run(internal.gdpr.steps.collectSettings, { userId }, { dedupId: stepDedupId(scope, "collect-settings") }),
        );

        await progress({ currentStep: "collecting_conversations", progress: 30 });
        const conversations = await context.step.do(
            "collect-conversations",
            async () => await context.run(internal.gdpr.steps.collectConversations, { userId }, { dedupId: stepDedupId(scope, "collect-conversations") }),
        );

        await progress({ currentStep: "collecting_files", progress: 50 });
        const files = await context.step.do(
            "collect-files",
            async () => await context.run(internal.gdpr.steps.collectFiles, { userId }, { dedupId: stepDedupId(scope, "collect-files") }),
        );

        await progress({ currentStep: "collecting_prompts", progress: 60 });
        const prompts = await context.step.do(
            "collect-prompts",
            async () => await context.run(internal.gdpr.steps.collectPrompts, { userId }, { dedupId: stepDedupId(scope, "collect-prompts") }),
        );

        const threadTags = await context.step.do(
            "collect-thread-tags",
            async () => await context.run(internal.gdpr.steps.collectThreadTags, { userId }, { dedupId: stepDedupId(scope, "collect-thread-tags") }),
        );

        const tasks = await context.step.do(
            "collect-tasks",
            async () => await context.run(internal.tasks.gdpr.collectTasksForExport, { userId }, { dedupId: stepDedupId(scope, "collect-tasks") }),
        );
        const memories = await context.step.do(
            "collect-memories",
            async () => await context.run(internal.memory.gdpr.collectMemoriesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-memories") }),
        );
        const evals = await context.step.do(
            "collect-evals",
            async () => await context.run(internal.evals.gdpr.collectEvalsForExport, { userId }, { dedupId: stepDedupId(scope, "collect-evals") }),
        );
        // A page per step, so no checkpoint outgrows the log's size limit however many drafts there are. The first
        // step keeps the old name: an in-flight run's recorded result has no cursor and reads as the only page.
        const reviewDrafts = await collectAllReviewDrafts(async (cursor, page) => {
            const name = page === 0 ? "collect-review-drafts" : `collect-review-drafts-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(internal.source_control.gdpr.collectReviewDraftsForExport, { cursor, userId }, { dedupId: stepDedupId(scope, name) }),
            );
        });
        const pullRequestGuides = await collectAllGuides(async (cursor, page) => {
            const name = `collect-pull-request-guides-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(
                        internal.source_control.gdpr.collectGuidesForExport,
                        { cursor, userId },
                        { dedupId: stepDedupId(scope, "collect-pull-request-guides", page) },
                    ),
            );
        });
        const pullRequestThreads = await collectAllPullRequestThreads(async (cursor, page) => {
            const name = `collect-pull-request-threads-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(
                        internal.source_control.gdpr.collectPullRequestThreadsForExport,
                        { cursor, userId },
                        { dedupId: stepDedupId(scope, "collect-pull-request-threads", page) },
                    ),
            );
        });
        const watchedRepositories = await context.step.do(
            "collect-watched-repositories",
            // An id of its own: a replay skips finished steps, which shifts the body's positional dispatch ids.
            async () =>
                await context.run(
                    internal.source_control.gdpr.collectWatchedRepositoriesForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-watched-repositories") },
                ),
        );
        const bots = await context.step.do(
            "collect-bots",
            async () => await context.run(internal.bots.gdpr.collectBotsForExport, { userId }, { dedupId: stepDedupId(scope, "collect-bots") }),
        );
        const codingAgentRuns = await context.step.do(
            "collect-coding-agent-runs",
            async () =>
                await context.run(
                    internal.coding_agents.gdpr.collectCodingAgentRunsForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-coding-agent-runs") },
                ),
        );

        const notifications = await context.step.do(
            "collect-notifications",
            async () =>
                await context.run(
                    internal.notifications.gdpr.collectNotificationsForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-notifications") },
                ),
        );
        const pages = await context.step.do(
            "collect-pages",
            async () => await context.run(internal.pages.gdpr.collectPagesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-pages") }),
        );
        const devices = await context.step.do(
            "collect-devices",
            async () => await context.run(internal.devices.gdpr.collectDevicesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-devices") }),
        );
        const activity = await context.step.do(
            "collect-activity",
            async () => await context.run(internal.gdpr.steps.collectActivityForExport, { userId }, { dedupId: stepDedupId(scope, "collect-activity") }),
        );

        // `context.run` is typed `Promise<unknown>` — the runner does not thread a
        // function's return type through — so `step.do` infers `unknown` and the
        // guard below narrows it to `{}`. Cast at the boundary, same as
        // `chat-import/workflows/import-workflow.ts` does. The value is the R2
        // object key `generateExportFile` returns.
        // The run's usage object, found by the key the run derives. Deleted on every terminal path, by a step the runtime retries.
        const deleteUsageObject = async (): Promise<void> => {
            const key = usageObjectKey(scope);

            await context.step.do(
                "delete-usage-json",
                async () => await context.run(internal.gdpr.steps.deleteUsageJson, { key }, { dedupId: stepDedupId(scope, "delete-usage-json") }),
            );
        };

        const failExport = async (message: string): Promise<void> => {
            await progress({ errorMessage: message, progress: 80, status: "failed" });

            await context.step.do(
                "notify-export-failed",
                async () =>
                    await context.run(
                        internal.notifications.functions.createNotification,
                        {
                            body: message,
                            dedupeKey: `data_export:${requestId}`,
                            link: "/dashboard/settings/privacy",
                            outcome: "failure",
                            title: "Data export",
                            type: "data_export",
                            userId,
                        },
                        { dedupId: stepDedupId(scope, "notify-export-failed") },
                    ),
            );

            // A failed export keeps nothing: its usage object and its pieces hold the user's usage, and no file was stored from them.
            // The object goes first, so a failed clear cannot leave it behind.
            await deleteUsageObject();
            await clearUsagePieces(usageIo);
        };

        let storageId: Id<"_storage"> | undefined;
        // The usage JSON the usage action stored for this run, deleted if the export fails.
        let usageKey: string | undefined;

        // The usage history, written a page at a time into this run's pieces (`gdpr/usage-export-steps.ts`). Each step is a
        // durable checkpoint, so a retry resumes at the first step that did not finish. The pieces are keyed by the run, not
        // the request, so two runs of one request never share them.
        const usageIo: UsageExportIo = {
            clear: async (name) =>
                (await context.run(internal.usage.gdpr.clearUsageExportPieces, { requestId: scope, userId }, { dedupId: stepDedupId(scope, name) })) as {
                    hasMore: boolean;
                },
            countRows: async (name, page) =>
                (await context.run(
                    internal.usage.gdpr.countUsageRowsPage,
                    { cursor: page.cursor, cutoff: page.cutoff, userId },
                    { dedupId: stepDedupId(scope, name) },
                )) as {
                    backfill: string;
                    closed: { cost: number; replies: number; rows: number; tokens: number };
                    cursor: string | null;
                },
            pause: async (name) => await context.step.sleep(name, "1 minute"),
            persistRows: async (name, page) =>
                (await context.run(
                    internal.usage.gdpr.persistUsageRowsPage,
                    { ...page, requestId: scope, userId },
                    { dedupId: stepDedupId(scope, name) },
                )) as UsagePageSummary,
            persistTitles: async (name, group) =>
                (await context.run(
                    internal.usage.activity.persistUsageTitles,
                    { ...group, requestId: scope, userId },
                    { dedupId: stepDedupId(scope, name) },
                )) as {
                    bytes: number;
                    done: boolean;
                    next: number;
                    titles: number;
                },
            step: async (name, run) => await context.step.do(name, run),
            verifyTitles: async (name, group) =>
                (await context.run(
                    internal.usage.activity.verifyUsageTitles,
                    { ...group, requestId: scope, userId },
                    { dedupId: stepDedupId(scope, name) },
                )) as {
                    bytes: number;
                    done: boolean;
                    next: number;
                    titles: number;
                },
        };

        try {
            await progress({ currentStep: "collecting_usage", progress: 70 });
            const collected = await collectUsageExport(usageIo);

            // The usage action reads the kept pass into its own JSON object; the pieces it read are then cleared.
            const prepared = (await context.step.do(
                "prepare-usage",
                async () =>
                    await context.run(
                        internal.gdpr.steps.prepareUsageForExport,
                        { pass: collected.pass, requestId: scope, userId },
                        { dedupId: stepDedupId(scope, "prepare-usage") },
                    ),
            )) as string | null;

            // The usage action reports an oversized usage as `null`; the reason is raised here, where it keeps its type.
            if (prepared === null) {
                throw new UsageExportError("too-large");
            }

            usageKey = prepared;

            await progress({ currentStep: "generating_export", progress: 80 });
            storageId = (await context.step.do(
                "generate-export-file",
                async () =>
                    await context.run(
                        internal.gdpr.steps.generateExportFile,
                        {
                            activity,
                            bots,
                            codingAgentRuns,
                            conversations,
                            devices,
                            evals,
                            files,
                            memories,
                            notifications,
                            pages,
                            profile,
                            prompts,
                            pullRequestGuides,
                            pullRequestThreads,
                            requestId,
                            reviewDrafts,
                            settings,
                            tasks,
                            threadTags,
                            usageKey,
                            userEmail,
                            userId,
                            watchedRepositories,
                        },
                        { dedupId: stepDedupId(scope, "generate-export-file") },
                    ),
            )) as Id<"_storage"> | undefined;
        } catch (error) {
            // Do not rethrow: the row is already failed, and a rethrow would make the runtime retry the whole handler.
            await failExport(exportFailureMessage(error));

            return;
        }

        if (!storageId) {
            await failExport("Failed to generate export file");

            return;
        }

        // The file's record comes first: once the file is stored, a failure in the cleanup below cannot leave it without its record.
        await progress({ currentStep: "sending_notification", progress: 90 });
        await progress({ progress: 100, status: "completed", storageId });

        await context.step.do(
            "notify-export-ready",
            async () =>
                await context.run(
                    internal.notifications.functions.createNotification,
                    {
                        dedupeKey: `data_export:${requestId}`,
                        link: "/dashboard/settings/privacy",
                        outcome: "success",
                        title: "Data export",
                        type: "data_export",
                        userId,
                    },
                    { dedupId: stepDedupId(scope, "notify-export-ready") },
                ),
        );
        await context.step.do(
            "send-ready-email",
            async () =>
                await context.run(internal.gdpr.steps.sendExportReadyEmail, { requestId, userEmail }, { dedupId: stepDedupId(scope, "send-ready-email") }),
        );

        await context.step.do(
            "log-audit",
            async () =>
                await context.run(
                    internal.gdpr.functions.logAudit,
                    {
                        action: "export_completed",
                        details: JSON.stringify({ requestId }),
                        performedBy: "system",
                        userId,
                    },
                    { dedupId: stepDedupId(scope, "log-audit") },
                ),
        );

        // The usage object it was read from, and the run's pieces, are no longer needed. They go after the audit: a cleanup that fails
        // permanently leaves the sweep to remove them, and must not hide the export's record.
        await deleteUsageObject();
        await clearUsagePieces(usageIo);
    },
};

export default dataExportWorkflowConfig;
