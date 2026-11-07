/**
 * GDPR account deletion.
 *
 * On `@lunora/workflow` — durable over Cloudflare Workflows. Each deletion phase
 * is a `ctx.step.do(...)` checkpoint, which is what makes a partial failure
 * recoverable: a crash between "delete threads" and "delete files" resumes at
 * "delete files" instead of restarting a deletion that has already half applied.
 *
 * The scheduler shim this file briefly used could not do that, and a
 * partially-deleted account with no automatic recovery is the worst failure mode
 * in this codebase.
 *
 * Progress writes are NOT checkpointed — idempotent and cheap, and checkpointing
 * them would double the durable log for no benefit.
 *
 * Step names are stable identifiers in the durable log; renaming one makes
 * in-flight instances resume at the wrong place.
 */
import type { WorkflowConfig } from "@lunora/workflow";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { gdprLogger } from "../../lib/logger";
import { ROOT_SHARD_KEY } from "../../lib/shard-context";
import { onUserShard } from "../../lib/workflow-shard";
import { stepDedupId } from "./dedup-id";
import { DELETION_CONFIRMATION_CLAIM_TTL_MS, DELETION_CONFIRMATION_EMAIL_SCOPE, POSTHOG_FAILED_MESSAGE } from "../constants";

export interface DeletionParams {
    requestId: Id<"gdprRequests">;
    userEmail: string;
    userId: string;
}

/** Upper bound on batches per drained step — a guard against a row that never stops matching. */
const MAX_DRAIN_ROUNDS = 10_000;

/** Scheduling the analytics retry is the only thing that finishes a failed erasure, so it gets a longer budget than a default step (30 s doubling, about an hour in total). */
const SCHEDULE_RETRY_STEP_CONFIG = { retries: { backoff: "exponential", delay: "30 seconds", limit: 7 } } as const;

export const accountDeletionWorkflowConfig: WorkflowConfig<DeletionParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const args = context.params;
        // Scoped to this INSTANCE: a fresh instance for the same request (a restart after a failure) must run
        // its sweeps and its open check again, not read the first instance's cached answers.
        const scope = `${args.requestId}:${context.event.instanceId}`;
        const steps = internal.gdpr.steps.residual_deletion_steps;

        /**
         * Run a batched `{ hasMore }` mutation to exhaustion inside ONE durable step.
         * Each call is its own transaction, keyed per round by `stepDedupId`. A retry
         * inside the same workflow instance takes the finished rounds from the cache
         * and continues from the round that failed; a fresh instance runs every round
         * again, which is safe because every batch step is idempotent.
         */
        const drain = async (name: string, run: (round: number) => Promise<unknown>): Promise<void> => {
            await context.step.do(name, async () => {
                for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
                    const { hasMore } = (await run(round)) as { hasMore: boolean };

                    if (!hasMore) {
                        return round + 1;
                    }
                }

                throw new Error(`${name}: still had rows after ${String(MAX_DRAIN_ROUNDS)} batches`);
            });
        };

        // A re-run may start over a `failed` request, never over one that already ended: a completed
        // request would be reopened, its erasure repeated and `deletion_completed` written twice. A
        // step, so a replay of this instance reads the first answer instead of writing again.
        const isOpen = await context.step.do(
            "open-deletion-request",
            async () =>
                await context.run(
                    internal.gdpr.functions.updateRequestProgress,
                    {
                        currentStep: "revoking_sessions",
                        fromStatus: ["pending", "processing", "failed"],
                        progress: 3,
                        requestId: args.requestId,
                        status: "processing",
                    },
                    { dedupId: stepDedupId(scope, "open-deletion-request") },
                ),
        );

        if (isOpen === false) {
            return;
        }

        await context.step.do(
            "revoke-user-sessions",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.revokeUserSessions,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "revoke-user-sessions") },
                ),
        );

        // External side effects first: the Telegram deregistration needs the bot
        // token that `delete-user-settings` removes, a sandbox can only be
        // killed while its session row still names it, and a connector grant can
        // only be revoked while `delete-user-connectors` has not removed its tokens.
        await context.step.do(
            "deregister-messenger-webhooks",
            async () =>
                await context.run(steps.deregisterMessengerWebhooks, { userId: args.userId }, { dedupId: stepDedupId(scope, "deregister-messenger-webhooks") }),
        );
        // Tasks go before anything they could write: a recurring task firing
        // between "delete threads" and a late task step would create a thread that
        // survives the erasure. `claimRound` also refuses once this request exists;
        // "delete-user-tasks" below stays as the sweep for a round already in flight.
        await drain(
            "stop-user-tasks",
            async (round) =>
                await context.run(internal.tasks.gdpr.deleteUserTasks, { userId: args.userId }, { dedupId: stepDedupId(scope, "stop-user-tasks", round) }),
        );
        // Eval runs start headless agent runs too — same reasoning, same pair of steps.
        await drain(
            "stop-user-evals",
            async (round) =>
                await context.run(internal.evals.gdpr.deleteUserEvals, { userId: args.userId }, { dedupId: stepDedupId(scope, "stop-user-evals", round) }),
        );
        await context.step.do(
            "kill-user-sandboxes",
            async () => await context.run(steps.killUserSandboxes, { userId: args.userId }, { dedupId: stepDedupId(scope, "kill-user-sandboxes") }),
        );
        // Coding-agent runs: cancel and kill their sandboxes while the rows still name them.
        await context.step.do(
            "stop-user-coding-agents",
            async () =>
                await context.run(
                    internal.coding_agents.gdpr.stopUserCodingAgentRuns,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "stop-user-coding-agents") },
                ),
        );
        // Connector grants: revoked at the provider while the tokens still exist.
        await context.step.do(
            "revoke-connector-grants",
            async () => await context.run(steps.revokeUserConnectorGrants, { userId: args.userId }, { dedupId: stepDedupId(scope, "revoke-connector-grants") }),
        );
        // Pro: cancelled at Creem and its payment rows deleted, on `__root__` where
        // they live — `workflowContext.run`, since `context` pins the user's shard.
        await context.step.do(
            "cancel-user-billing",
            async () =>
                await workflowContext.run(
                    internal.billing.gdpr.cancelBilling,
                    { referenceId: args.userId },
                    { dedupId: stepDedupId(scope, "cancel-user-billing"), shardKey: ROOT_SHARD_KEY },
                ),
        );

        // --- Phase 1: Delete thread-dependent data BEFORE threads are removed ---

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_thread_metadata",
            progress: 6,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-thread-metadata",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserThreadMetadata,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-thread-metadata") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_thread_cascade",
            progress: 10,
            requestId: args.requestId,
        });

        // A cursor over the user's threads, passed back each round. A retry inside
        // the same workflow instance takes the finished rounds from the cache (their
        // `stepDedupId` is per round) and continues from the round that failed; a
        // fresh instance walks every round again, which is safe: every round only deletes.
        await context.step.do("delete-user-thread-cascade", async () => {
            let cursor: string | null = null;

            for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
                const result = (await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserThreadCascade,
                    { cursor, userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-thread-cascade", round) },
                )) as {
                    cursor: string | null;
                    hasMore: boolean;
                };

                if (!result.hasMore) {
                    return round + 1;
                }

                ({ cursor } = result);
            }

            throw new Error(`delete-user-thread-cascade: still had rows after ${String(MAX_DRAIN_ROUNDS)} batches`);
        });

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_documents",
            progress: 14,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-documents",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserDocuments,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-documents", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_presentations",
            progress: 18,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-presentations",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserPresentations,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-presentations", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_persistent_streams",
            progress: 22,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-persistent-streams",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserPersistentStreams,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-persistent-streams", round) },
                ),
        );

        await drain(
            "delete-user-sub-agent-runs",
            async (round) =>
                await context.run(steps.deleteUserSubAgentRuns, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-sub-agent-runs", round) }),
        );

        // --- Phase 2: Delete threads, messages, and streams ---

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_messages",
            progress: 25,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-all-for-user-id-async",
            async () =>
                await context.run(
                    internal.agent.users.deleteAllForUserIdAsync,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-all-for-user-id-async") },
                ),
        );

        // --- Phase 3: Delete remaining user-owned data ---

        // After the threads are gone: a compaction that finished after the per-thread erase is swept here.
        await drain(
            "delete-user-thread-summaries",
            async (round) =>
                await context.run(
                    steps.deleteUserThreadSummaries,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-thread-summaries", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_memories",
            progress: 40,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-memories",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserMemories,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-memories", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_knowledge",
            progress: 42,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-memory-reflection",
            async (round) =>
                await context.run(
                    internal.memory.gdpr.deleteUserMemoryReflectionData,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-memory-reflection", round) },
                ),
        );
        await drain(
            "delete-user-knowledge",
            async (round) =>
                await context.run(steps.deleteUserKnowledge, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-knowledge", round) }),
        );
        // After memories and knowledge: sweeps whatever embeddings they did not name.
        await drain(
            "delete-user-embeddings",
            async (round) =>
                await context.run(steps.deleteUserEmbeddings, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-embeddings", round) }),
        );
        await drain(
            "delete-user-streaming-messages",
            async (round) =>
                await context.run(
                    steps.deleteUserStreamingMessages,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-streaming-messages", round) },
                ),
        );
        await drain(
            "delete-user-integrations",
            async (round) =>
                await context.run(steps.deleteUserIntegrations, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-integrations", round) }),
        );
        await drain(
            "delete-user-tasks",
            async (round) =>
                await context.run(internal.tasks.gdpr.deleteUserTasks, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-tasks", round) }),
        );
        await drain(
            "delete-user-evals",
            async (round) =>
                await context.run(internal.evals.gdpr.deleteUserEvals, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-evals", round) }),
        );
        await drain(
            "delete-user-coding-agent-runs",
            async (round) =>
                await context.run(
                    internal.coding_agents.gdpr.deleteUserCodingAgentRuns,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-coding-agent-runs", round) },
                ),
        );
        await drain(
            "delete-user-notifications",
            async (round) =>
                await context.run(
                    internal.notifications.gdpr.deleteUserNotifications,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-notifications", round) },
                ),
        );
        await drain(
            "delete-user-pages",
            async (round) =>
                await context.run(internal.pages.gdpr.deleteUserPages, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-pages", round) }),
        );
        await drain(
            "delete-user-devices",
            async (round) =>
                await context.run(
                    internal.devices.gdpr.deleteUserDevices,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-devices", round) },
                ),
        );
        await drain(
            "delete-user-acp-sessions",
            async (round) =>
                await context.run(
                    internal.acp.gdpr.deleteUserAcpSessions,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-acp-sessions", round) },
                ),
        );
        await drain(
            "delete-user-review-drafts",
            async (round) =>
                await context.run(
                    internal.source_control.gdpr.deleteUserReviewDrafts,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-review-drafts", round) },
                ),
        );
        await drain(
            "delete-user-pull-request-threads",
            async (round) =>
                await context.run(
                    internal.source_control.gdpr.deleteUserPullRequestThreads,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-pull-request-threads", round) },
                ),
        );
        await drain(
            "delete-user-pull-request-guides",
            async (round) =>
                await context.run(
                    internal.source_control.gdpr.deleteUserGuides,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-pull-request-guides", round) },
                ),
        );
        // Its own dispatch id per batch: a replay skips the finished steps' callbacks, so the body's positional ids
        // drift and a call could be answered with an earlier call's cached result, leaving the rows in place.
        await drain(
            "delete-user-watched-repositories",
            async (round) =>
                await context.run(
                    internal.source_control.gdpr.deleteUserWatchedRepositories,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-watched-repositories", round) },
                ),
        );
        await drain(
            "anonymise-gateway-usage-deductions",
            async (round) =>
                await context.run(
                    steps.anonymiseGatewayUsageDeductions,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "anonymise-gateway-usage-deductions", round) },
                ),
        );
        await context.step.do(
            "delete-user-browser-data",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserBrowserData,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-browser-data") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_skills",
            progress: 45,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-skills",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserSkills,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-skills") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_connectors",
            progress: 50,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-connectors",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserConnectors,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-connectors") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_import_jobs",
            progress: 55,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-import-jobs",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserImportJobs,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-import-jobs", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_files",
            progress: 60,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-files",
            async (round) =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserFiles,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-files", round) },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_projects",
            progress: 65,
            requestId: args.requestId,
        });

        // Before the projects: it finds project-scoped rows through them.
        await drain(
            "delete-user-workflow-data",
            async (round) =>
                await context.run(steps.deleteUserWorkflowData, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-workflow-data", round) }),
        );

        await context.step.do(
            "delete-user-projects",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserProjects,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-projects") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_prompts",
            progress: 72,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-prompts",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserPrompts,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-prompts") },
                ),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_settings",
            progress: 80,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-usage-daily",
            async (round) =>
                await context.run(steps.deleteUserUsageDaily, { userId: args.userId }, { dedupId: stepDedupId(scope, "delete-user-usage-daily", round) }),
        );

        await context.step.do(
            "delete-user-settings",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteUserSettings,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-user-settings") },
                ),
        );

        // --- Phase 4: Delete auth records (must be last) ---

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_auth",
            progress: 90,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-auth-records",
            async () =>
                await context.run(
                    internal.gdpr.steps.deletion_steps.deleteAuthRecords,
                    {
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "delete-auth-records") },
                ),
        );

        await drain(
            "delete-user-identity",
            async (round) =>
                await context.run(
                    steps.deleteUserIdentity,
                    { userEmail: args.userEmail, userId: args.userId },
                    { dedupId: stepDedupId(scope, "delete-user-identity", round) },
                ),
        );
        // Last data step: every audited delete above wrote a `documentHistory` snapshot.
        await drain(
            "purge-user-document-history",
            async (round) =>
                await context.run(
                    steps.purgeUserDocumentHistory,
                    { userId: args.userId },
                    { dedupId: stepDedupId(scope, "purge-user-document-history", round) },
                ),
        );

        // --- Phase 5: Delete external analytics data ---

        // Throws on a PostHog failure, so the step retries and the request is never
        // marked completed (nor the confirmation mailed) while the person may remain.
        // Not "delete-post-hog-person": the old action returned null even on a failed
        // delete, and a run that cached that result would replay it instead of erasing.
        let postHogOutcome: unknown;

        try {
            postHogOutcome = await context.step.do(
                "erase-post-hog-person",
                async () =>
                    await context.run(
                        internal.gdpr.steps.posthog_steps.deletePostHogPerson,
                        { userId: args.userId },
                        { dedupId: stepDedupId(scope, "erase-post-hog-person") },
                    ),
            );
        } catch (error) {
            // Retries are exhausted. Everything else is already erased, so leaving the request
            // `processing` would hide this until the 30-day sweep: mark it failed and audit it
            // (a fixed message; the raw error carries the provider response), then rethrow so the
            // instance errors and never reaches completion. Unlike the export workflow this does not
            // return: the data is already gone, so the operator must see a failed instance, and a
            // re-run is safe (every step is idempotent) and ends in `completed` once PostHog works,
            // as does the scheduled retry. Both `failed` writes are conditional (`fromStatus`): a retry
            // or a re-run may have completed the request meanwhile, and that must not be reversed.
            try {
                await context.run(internal.gdpr.functions.updateRequestProgress, {
                    errorMessage: POSTHOG_FAILED_MESSAGE,
                    fromStatus: ["processing", "failed"],
                    requestId: args.requestId,
                    status: "failed",
                });
            } catch {
                // Best-effort, as below: a failing status write must not skip the minimisation that follows.
            }

            try {
                await context.step.do(
                    "log-audit-posthog-failed",
                    async () =>
                        await context.run(internal.gdpr.functions.logAudit, {
                            action: "deletion_failed",
                            details: JSON.stringify({ requestId: args.requestId }),
                            performedBy: "system",
                            userId: args.userId,
                        }),
                );
            } catch {
                // Best-effort: the data is already erased, and a failing audit must neither skip the
                // minimisation below nor replace the PostHog error the instance reports.
            }

            // Only the analytics erasure is retried, from the scheduler (`gdpr/posthog-retry.ts`): the
            // user can no longer sign in to ask again, and nothing else is left to do. The step gets
            // a long retry budget of its own, and `dedupId` keeps a retried attempt from queueing a
            // second job. The step also moves a still-`processing` request to `failed`, so the
            // status writes above being swallowed cannot strand the first attempt. If even that is
            // exhausted the error is logged at error level, never allowed to mask `error`.
            // `dedupId` must differ per FAILURE, not per request: the workflow's dedup table answers
            // a reused id with the first call's cached result without executing, so a re-run that
            // failed again would never start its own chain. The id comes from a step of its own,
            // which is durable, so a retried scheduling step still reuses it.
            let isEmailKept = false;

            try {
                const failureId = await context.step.do("post-hog-retry-failure-id", async () => crypto.randomUUID());

                // The mutation numbers the chain itself, from rows it writes in the same transaction. It
                // answers `false` when the request had already ended (a retry may have just completed it
                // and still owe the confirmation), so any answer, not only `true`, keeps the address.
                await context.step.do(
                    "schedule-post-hog-retry",
                    SCHEDULE_RETRY_STEP_CONFIG,
                    async () =>
                        await context.run(
                            internal.gdpr.posthog_retry.schedulePostHogRetry,
                            { failureId: String(failureId), requestId: args.requestId, userEmail: args.userEmail, userId: args.userId },
                            { dedupId: `post-hog-retry:${args.requestId}:${String(failureId)}` },
                        ),
                );

                isEmailKept = true;
            } catch (scheduleError) {
                gdprLogger.error(`Analytics erasure retry for request ${args.requestId} could not be scheduled`, scheduleError);
            }

            // Minimise after the failure audit, as on the success path. A retry (queued, or one that
            // completed the request meanwhile) still needs the address for the confirmation email, and
            // clears it when its confirmation is settled or its chain ends: this request keeps it until
            // then. Without a retry nothing ever would, so the address goes now. Its own failure must not replace the PostHog error the instance
            // reports; a re-run minimises again (the step is idempotent).
            try {
                await context.step.do(
                    "minimise-gdpr-records-posthog-failed",
                    async () => await context.run(steps.minimiseGdprRecords, { userId: args.userId, ...(isEmailKept && { retainEmailOf: args.requestId }) }),
                );
                // Minimisation clears every request's free-text `errorMessage`. This one is a fixed,
                // non-personal string, so put it back: the user's status must still say what failed.
                await context.run(internal.gdpr.functions.updateRequestProgress, {
                    errorMessage: POSTHOG_FAILED_MESSAGE,
                    fromStatus: ["processing", "failed"],
                    requestId: args.requestId,
                    status: "failed",
                });
            } catch {
                // Deliberately swallowed: `error` below is the root cause.
            }

            throw error;
        }

        // Only the transition from an open request is this run's: a scheduled retry that completed the
        // request first has written its own `deletion_completed` and owes its own confirmation, so a
        // second audit row, minimisation and mail would double it (and clear the address it still needs).
        const isCompleted = await context.step.do(
            "complete-deletion-request",
            async () =>
                await context.run(
                    internal.gdpr.functions.updateRequestProgress,
                    {
                        fromStatus: ["processing", "failed"],
                        progress: 100,
                        requestId: args.requestId,
                        status: "completed",
                    },
                    { dedupId: stepDedupId(scope, "complete-deletion-request") },
                ),
        );

        if (isCompleted === false) {
            return;
        }

        await context.step.do(
            "log-audit",
            async () =>
                await context.run(
                    internal.gdpr.functions.logAudit,
                    {
                        action: "deletion_completed",
                        // deleted | no_profile (verified project, no such person) | skipped (not configured: nothing was erased there).
                        details: JSON.stringify({ posthog: postHogOutcome, requestId: args.requestId }),
                        performedBy: "system",
                        userId: args.userId,
                    },
                    { dedupId: stepDedupId(scope, "log-audit") },
                ),
        );

        // After the final audit write: keep the compliance record, minus the PII.
        await context.step.do(
            "minimise-gdpr-records",
            async () => await context.run(steps.minimiseGdprRecords, { userId: args.userId }, { dedupId: stepDedupId(scope, "minimise-gdpr-records") }),
        );

        // Last, and best effort: the deletion is complete and minimised whether or not this goes out, so
        // a failing mail must not fail the instance after the fact. The address comes from the workflow's
        // own params (the request row is minimised by now); the claim is shared with the scheduled retry,
        // so a re-run of a request the retry already confirmed mails nothing while the claim lasts (a
        // re-run no longer starts over a completed request at all). A send that is exhausted keeps the
        // claim: nothing keeps the address afterwards, so there is nothing a later sender could send.
        try {
            const isEmailClaimed = await context.step.do(
                "claim-deletion-confirmed-email",
                async () =>
                    await context.run(
                        internal.lib.claim_once.claimKey,
                        {
                            key: args.requestId,
                            scope: DELETION_CONFIRMATION_EMAIL_SCOPE,
                            ttlMs: DELETION_CONFIRMATION_CLAIM_TTL_MS,
                        },
                        { dedupId: stepDedupId(scope, "claim-deletion-confirmed-email") },
                    ),
            );

            if (isEmailClaimed) {
                await context.step.do(
                    "send-deletion-confirmed-email-action",
                    async () =>
                        await context.run(
                            internal.gdpr.steps.email_steps.sendDeletionConfirmedEmailAction,
                            {
                                userEmail: args.userEmail,
                            },
                            { dedupId: stepDedupId(scope, "send-deletion-confirmed-email-action") },
                        ),
                );
            }
        } catch (error) {
            gdprLogger.error(`Deletion confirmation email for request ${args.requestId} was not sent (${error instanceof Error ? error.name : "unknown"})`);
        }
    },
};

export default accountDeletionWorkflowConfig;
