/**
 * Outbound mail through `@lunora/mail`.
 *
 * `createMailerFromEnv` picks the transport from the Worker env, in this order:
 *
 * 1. **Capture** in a dev environment (`lunora dev` sets `WORKER_ENV=development`,
 *    `.dev.vars` sets `ENVIRONMENT=development`): every send lands in the studio's
 *    Mail tab instead of going out. Recording it uses `LUNORA_ADMIN_TOKEN`, which
 *    `lunora dev` generates into `.dev.vars`.
 * 2. **Cloudflare Email Service** when the `EMAIL` `send_email` binding exists —
 *    `alchemy.run.ts` binds it only when `MAIL_FROM` is set and `RESEND_API_KEY`
 *    is not. No API token: the binding is the credential.
 * 3. **Resend** when `RESEND_API_KEY` is set — the fallback for a deployment whose
 *    Email Service sending domain is not verified yet (Email Service rejects an
 *    unverified sender with `E_SENDER_NOT_VERIFIED`).
 *
 * With none of them the mailer still queues, and `deliverEmail`'s send rejects,
 * so a deploy without a transport fills the jobs DLQ (logged there) instead of
 * dropping password resets silently; `alchemy.run.ts` refuses a production
 * deploy without `MAIL_FROM` for the same reason.
 *
 * ## Queued, not sent inline
 *
 * {@link queueEmail} renders now and delivers through the jobs queue
 * (`lib/job-queue.ts`), so a provider blip is retried by the queue (and lands in
 * its DLQ) instead of failing the auth request that triggered it. Delivery is
 * at-least-once: a delivery that sent and then lost its ack sends again. For a
 * verification link or an OTP a rare duplicate is the right trade against a lost
 * mail, so `deliverEmail` does not claim the message's `idempotencyKey`.
 */
import type { Mailer, MailEnv, QueueLike, SendOptions } from "@lunora/mail";
import { createMailerFromEnv } from "@lunora/mail";
import { env } from "cloudflare:workers";

import { internal } from "../_generated/internal";
import { enqueueJob } from "../lib/job-queue";

// A plain copy, not a cast: `env`'s type is the Worker's ambient `Env`, which
// differs per project (the web app type-checks this file against its own).
const workerEnv: MailEnv = Object.fromEntries(Object.entries(env));

/** `mailer.queue()` hands the rendered payload here; `deliverEmail` sends it from the queue. */
const jobsQueue: QueueLike = {
    send: async (message) => {
        await enqueueJob(internal.email.functions.deliverEmail, { message });
    },
};

/**
 * Built per call (no I/O) so the transport follows the env as it is now — tests
 * swap bindings on the `cloudflare:workers` stub. `cloudflareSend` goes in only when the `EMAIL`
 * binding exists — `createMailerFromEnv` prefers it over `RESEND_API_KEY` whenever it is passed.
 */
export const mailer = (): Mailer => {
    const binding = (env as { EMAIL?: SendEmail }).EMAIL;

    if (!binding) {
        return createMailerFromEnv(workerEnv, { queue: jobsQueue });
    }

    return createMailerFromEnv(workerEnv, {
        // `@lunora/mail` builds the RFC 822 message; the binding's raw-MIME overload sends it.
        cloudflareSend: async (from, to, raw) => {
            const { EmailMessage } = await import("cloudflare:email");

            await binding.send(new EmailMessage(from, to, raw));
        },
        queue: jobsQueue,
    });
};

/** Render `react` now, deliver from the jobs queue. */
export const queueEmail = async (options: Pick<SendOptions, "react" | "subject" | "to">): Promise<void> => {
    await mailer().queue(options);
};
