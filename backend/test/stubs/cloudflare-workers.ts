/**
 * Test stub for the `cloudflare:workers` runtime module.
 *
 * `email/mailer.ts` and `lib/job-queue.ts` read their bindings off `env`, and
 * that module only exists inside workerd — Node cannot resolve the specifier at
 * all, so a static import of it fails every test that transitively reaches
 * either. Aliasing it here keeps the production code honest: the alternative
 * was a dynamic import with a swallowed error, which would hide a genuinely
 * missing binding at runtime as easily as it hides the test environment.
 *
 * No `EMAIL` binding on purpose: with `MAIL_FROM` and a Resend key the mailer
 * builds its Resend transport, and every send goes through `QUEUE_JOBS` below,
 * so nothing reaches the network.
 *
 * `QUEUE_JOBS` records what `lib/job-queue.ts:enqueueJob` sends, so a test can
 * assert that a job was enqueued (the queue analogue of the harness's
 * `scheduler.list()`). Import `jobsQueueMessages` from THIS file — the alias
 * resolves to the same module, so it is the same array — and clear it between
 * tests.
 */
export interface RecordedQueueMessage {
    body: { args?: Record<string, unknown>; functionPath: string; shardKey?: string };
    delaySeconds?: number;
}

export const jobsQueueMessages: RecordedQueueMessage[] = [];

export const env: { EMAIL?: unknown; MAIL_FROM: string; QUEUE_JOBS: unknown; RESEND_API_KEY: string } = {
    MAIL_FROM: "Neore <noreply@neore.test>",
    QUEUE_JOBS: {
        send: async (body: RecordedQueueMessage["body"], options?: { delaySeconds?: number }) => {
            jobsQueueMessages.push({ body, ...(options?.delaySeconds !== undefined && { delaySeconds: options.delaySeconds }) });
        },
        sendBatch: async (messages: Iterable<{ body: RecordedQueueMessage["body"] }>) => {
            for (const message of messages) {
                jobsQueueMessages.push({ body: message.body });
            }
        },
    },
    RESEND_API_KEY: "re_test",
};
