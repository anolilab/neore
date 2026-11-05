/**
 * Outbound mail through `@lunora/mail`.
 *
 * `createMailerFromEnv` picks the transport from the Worker env, in this order:
 *
 * 1. **Capture** in a dev environment (`lunora dev` sets `WORKER_ENV=development`,
 *    `.dev.vars` sets `ENVIRONMENT=development`): every send lands in the studio's
 *    Mail tab instead of going out. Recording it uses `LUNORA_ADMIN_TOKEN`, which
 *    `lunora dev` generates into `.dev.vars`.
 * 2. **Cloudflare Email Service** through the `EMAIL` `send_email` binding, which
 *    `alchemy.run.ts` binds when `MAIL_FROM` is set and `MAIL_EMAIL_SERVICE=1`.
 *    No API token: the binding is the credential. Email Service rejects a sender
 *    off its verified domain (`E_SENDER_NOT_VERIFIED`).
 *
 * With neither, the mailer still queues, and `deliverEmail`'s send rejects,
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
import { createMailerFromEnv, shouldCaptureMail } from "@lunora/mail";
import { env } from "cloudflare:workers";

import { internal } from "../_generated/internal";
import { enqueueJob } from "../lib/job-queue";

// A plain copy, not a cast: `env`'s type is the Worker's ambient `Env`, which
// differs per project (the web app type-checks this file against its own).
// `RESEND_API_KEY` is left out: `createMailerFromEnv` would send through Resend
// with it, and Cloudflare Email Service is the only transport (`deliversMail`).
const workerEnv: MailEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "RESEND_API_KEY"));

/** `mailer.queue()` hands the rendered payload here; `deliverEmail` sends it from the queue. */
const jobsQueue: QueueLike = {
    send: async (message) => {
        await enqueueJob(internal.email.functions.deliverEmail, { message });
    },
};

/**
 * Built per call (no I/O) so the transport follows the env as it is now — tests
 * swap bindings on the `cloudflare:workers` stub. `cloudflareSend` goes in only when the `EMAIL`
 * binding exists.
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

/**
 * Whether mail sent from here reaches an inbox: through Cloudflare Email Service (the `EMAIL` binding), from a
 * `MAIL_FROM` sender. Dev capture is not delivery, and neither is a deploy with no binding. Read from the live env,
 * like {@link mailer}.
 */
export const deliversMail = (): boolean => {
    const current = env as { EMAIL?: SendEmail; MAIL_FROM?: string };

    return current.EMAIL !== undefined && Boolean(current.MAIL_FROM?.trim()) && !shouldCaptureMail(Object.fromEntries(Object.entries(env)));
};

/** Render `react` now, deliver from the jobs queue. */
export const queueEmail = async (options: Pick<SendOptions, "react" | "subject" | "to">): Promise<void> => {
    await mailer().queue(options);
};
