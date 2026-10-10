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
import { ROOT_SHARD_KEY } from "../../lib/shard-context";
import { onUserShard } from "../../lib/workflow-shard";

export interface DeletionParams {
    requestId: Id<"gdprRequests">;
    userEmail: string;
    userId: string;
}

/** Upper bound on batches per drained step — a guard against a row that never stops matching. */
const MAX_DRAIN_ROUNDS = 10_000;

export const accountDeletionWorkflowConfig: WorkflowConfig<DeletionParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const args = context.params;
        const steps = internal.gdpr.steps.residual_deletion_steps;

        /**
         * Run a batched `{ hasMore }` mutation to exhaustion inside ONE durable step.
         * Each call is its own transaction; a retried step starts over, which is
         * safe because every batch step is idempotent.
         */
        const drain = async (name: string, run: () => Promise<unknown>): Promise<void> => {
            await context.step.do(name, async () => {
                for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
                    const { hasMore } = (await run()) as { hasMore: boolean };

                    if (!hasMore) {
                        return round + 1;
                    }
                }

                throw new Error(`${name}: still had rows after ${String(MAX_DRAIN_ROUNDS)} batches`);
            });
        };

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "revoking_sessions",
            progress: 3,
            requestId: args.requestId,
            status: "processing",
        });

        await context.step.do(
            "revoke-user-sessions",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.revokeUserSessions, {
                    userId: args.userId,
                }),
        );

        // External side effects first: the Telegram deregistration needs the bot
        // token that `delete-user-settings` removes, a sandbox can only be
        // killed while its session row still names it, and a connector grant can
        // only be revoked while `delete-user-connectors` has not removed its tokens.
        await context.step.do("deregister-messenger-webhooks", async () => await context.run(steps.deregisterMessengerWebhooks, { userId: args.userId }));
        // Tasks go before anything they could write: a recurring task firing
        // between "delete threads" and a late task step would create a thread that
        // survives the erasure. `claimRound` also refuses once this request exists;
        // "delete-user-tasks" below stays as the sweep for a round already in flight.
        await drain("stop-user-tasks", async () => await context.run(internal.tasks.gdpr.deleteUserTasks, { userId: args.userId }));
        // Eval runs start headless agent runs too — same reasoning, same pair of steps.
        await drain("stop-user-evals", async () => await context.run(internal.evals.gdpr.deleteUserEvals, { userId: args.userId }));
        await context.step.do("kill-user-sandboxes", async () => await context.run(steps.killUserSandboxes, { userId: args.userId }));
        // Coding-agent runs: cancel and kill their sandboxes while the rows still name them.
        await context.step.do(
            "stop-user-coding-agents",
            async () => await context.run(internal.coding_agents.gdpr.stopUserCodingAgentRuns, { userId: args.userId }),
        );
        // Connector grants: revoked at the provider while the tokens still exist.
        await context.step.do("revoke-connector-grants", async () => await context.run(steps.revokeUserConnectorGrants, { userId: args.userId }));
        // Pro: cancelled at Creem and its payment rows deleted, on `__root__` where
        // they live — `workflowContext.run`, since `context` pins the user's shard.
        await context.step.do(
            "cancel-user-billing",
            async () => await workflowContext.run(internal.billing.gdpr.cancelBilling, { referenceId: args.userId }, { shardKey: ROOT_SHARD_KEY }),
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
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserThreadMetadata, {
                    userId: args.userId,
                }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_thread_cascade",
            progress: 10,
            requestId: args.requestId,
        });

        // A cursor over the user's threads, passed back each round. A retried
        // step starts the walk over, which is safe: every round only deletes.
        await context.step.do("delete-user-thread-cascade", async () => {
            let cursor: string | null = null;

            for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
                const result = (await context.run(internal.gdpr.steps.deletion_steps.deleteUserThreadCascade, { cursor, userId: args.userId })) as {
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

        await drain("delete-user-documents", async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserDocuments, { userId: args.userId }));

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_presentations",
            progress: 18,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-presentations",
            async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserPresentations, { userId: args.userId }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_persistent_streams",
            progress: 22,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-persistent-streams",
            async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserPersistentStreams, { userId: args.userId }),
        );

        await drain("delete-user-sub-agent-runs", async () => await context.run(steps.deleteUserSubAgentRuns, { userId: args.userId }));

        // --- Phase 2: Delete threads, messages, and streams ---

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_messages",
            progress: 25,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-all-for-user-id-async",
            async () =>
                await context.run(internal.agent.users.deleteAllForUserIdAsync, {
                    userId: args.userId,
                }),
        );

        // --- Phase 3: Delete remaining user-owned data ---

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_memories",
            progress: 40,
            requestId: args.requestId,
        });

        await drain("delete-user-memories", async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserMemories, { userId: args.userId }));

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_knowledge",
            progress: 42,
            requestId: args.requestId,
        });

        await drain(
            "delete-user-memory-reflection",
            async () => await context.run(internal.memory.gdpr.deleteUserMemoryReflectionData, { userId: args.userId }),
        );
        await drain("delete-user-knowledge", async () => await context.run(steps.deleteUserKnowledge, { userId: args.userId }));
        // After memories and knowledge: sweeps whatever embeddings they did not name.
        await drain("delete-user-embeddings", async () => await context.run(steps.deleteUserEmbeddings, { userId: args.userId }));
        await drain("delete-user-streaming-messages", async () => await context.run(steps.deleteUserStreamingMessages, { userId: args.userId }));
        await drain("delete-user-integrations", async () => await context.run(steps.deleteUserIntegrations, { userId: args.userId }));
        await drain("delete-user-tasks", async () => await context.run(internal.tasks.gdpr.deleteUserTasks, { userId: args.userId }));
        await drain("delete-user-evals", async () => await context.run(internal.evals.gdpr.deleteUserEvals, { userId: args.userId }));
        await drain(
            "delete-user-coding-agent-runs",
            async () => await context.run(internal.coding_agents.gdpr.deleteUserCodingAgentRuns, { userId: args.userId }),
        );
        await drain("delete-user-notifications", async () => await context.run(internal.notifications.gdpr.deleteUserNotifications, { userId: args.userId }));
        await drain("delete-user-pages", async () => await context.run(internal.pages.gdpr.deleteUserPages, { userId: args.userId }));
        await drain("delete-user-devices", async () => await context.run(internal.devices.gdpr.deleteUserDevices, { userId: args.userId }));
        await drain("anonymise-gateway-usage-deductions", async () => await context.run(steps.anonymiseGatewayUsageDeductions, { userId: args.userId }));
        await context.step.do(
            "delete-user-browser-data",
            async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserBrowserData, { userId: args.userId }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_skills",
            progress: 45,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-skills",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserSkills, {
                    userId: args.userId,
                }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_connectors",
            progress: 50,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-connectors",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserConnectors, {
                    userId: args.userId,
                }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_import_jobs",
            progress: 55,
            requestId: args.requestId,
        });

        await drain("delete-user-import-jobs", async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserImportJobs, { userId: args.userId }));

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_files",
            progress: 60,
            requestId: args.requestId,
        });

        await drain("delete-user-files", async () => await context.run(internal.gdpr.steps.deletion_steps.deleteUserFiles, { userId: args.userId }));

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_projects",
            progress: 65,
            requestId: args.requestId,
        });

        // Before the projects: it finds project-scoped rows through them.
        await drain("delete-user-workflow-data", async () => await context.run(steps.deleteUserWorkflowData, { userId: args.userId }));

        await context.step.do(
            "delete-user-projects",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserProjects, {
                    userId: args.userId,
                }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_prompts",
            progress: 72,
            requestId: args.requestId,
        });

        await context.step.do(
            "delete-user-prompts",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserPrompts, {
                    userId: args.userId,
                }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            currentStep: "deleting_settings",
            progress: 80,
            requestId: args.requestId,
        });

        await drain("delete-user-usage-daily", async () => await context.run(steps.deleteUserUsageDaily, { userId: args.userId }));

        await context.step.do(
            "delete-user-settings",
            async () =>
                await context.run(internal.gdpr.steps.deletion_steps.deleteUserSettings, {
                    userId: args.userId,
                }),
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
                await context.run(internal.gdpr.steps.deletion_steps.deleteAuthRecords, {
                    userId: args.userId,
                }),
        );

        await drain("delete-user-identity", async () => await context.run(steps.deleteUserIdentity, { userEmail: args.userEmail, userId: args.userId }));
        // Last data step: every audited delete above wrote a `documentHistory` snapshot.
        await drain("purge-user-document-history", async () => await context.run(steps.purgeUserDocumentHistory, { userId: args.userId }));

        // --- Phase 5: Delete external analytics data ---

        await context.step.do(
            "delete-post-hog-person",
            async () => await context.run(internal.gdpr.steps.posthog_steps.deletePostHogPerson, { userId: args.userId }),
        );

        await context.run(internal.gdpr.functions.updateRequestProgress, {
            progress: 100,
            requestId: args.requestId,
            status: "completed",
        });

        await context.step.do(
            "send-deletion-confirmed-email-action",
            async () =>
                await context.run(internal.gdpr.steps.email_steps.sendDeletionConfirmedEmailAction, {
                    userEmail: args.userEmail,
                }),
        );

        await context.step.do(
            "log-audit",
            async () =>
                await context.run(internal.gdpr.functions.logAudit, {
                    action: "deletion_completed",
                    details: JSON.stringify({ requestId: args.requestId }),
                    performedBy: "system",
                    userId: args.userId,
                }),
        );

        // After the final audit write: keep the compliance record, minus the PII.
        await context.step.do("minimise-gdpr-records", async () => await context.run(steps.minimiseGdprRecords, { userId: args.userId }));
    },
};

export default accountDeletionWorkflowConfig;
