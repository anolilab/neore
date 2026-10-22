/**
 * Restarting a failed chat import. A failed import keeps a copy of its file for
 * {@link RESTART_WINDOW_MS}, so the user can run it again; after that the copy is
 * reaped. Pure helpers only, so the rules are unit-tested without a harness.
 */

/** The `errorMessage` a user cancel writes. A cancelled import is never restarted. */
export const CANCELLED_IMPORT_MESSAGE = "Cancelled by user";

/** How long a failed import's file is kept for a restart before it is deleted. */
export const RESTART_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RestartableJob {
    errorMessage?: string;
    failedConversations?: number;
    importedConversations?: number;
    r2Key?: string;
    status: "pending" | "processing" | "completed" | "failed";
    totalConversations: number;
}

/** Whether a run has conversations left: every one already saved or counted as failed would make a restart a no-op. */
export const hasConversationsLeft = (job: Pick<RestartableJob, "failedConversations" | "importedConversations" | "totalConversations">): boolean =>
    (job.importedConversations ?? 0) + (job.failedConversations ?? 0) < job.totalConversations;

/** Failed, not cancelled, still holding its file, and with work left. Old failed jobs hold `""` and stay out. */
export const isRestartable = (job: RestartableJob): boolean =>
    job.status === "failed" && job.errorMessage !== CANCELLED_IMPORT_MESSAGE && Boolean(job.r2Key) && hasConversationsLeft(job);

/** The key a failed import's file is kept under. Server-minted, so it is never a staging key the reap or sweep would delete. */
export const keptImportKeyFor = (userId: string, jobId: string): string => `chat-import/${userId}/${jobId}`;

/** Progress once `done` of `total` conversations are counted: 5% setup, 90% conversations. A restart starts there, not at 0. */
export const resumeProgress = (done: number, total: number): number => (total > 0 ? 5 + Math.round((Math.min(done, total) / total) * 90) : 5);
