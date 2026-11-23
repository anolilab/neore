/**
 * The Events webhook sender (part 2b): the internal actions the jobs queue runs, and one attempt around one POST. Actions are where
 * outbound calls belong; the claim and the outcome are mutations on the owner's shard (`event-webhook-deliveries.ts`).
 *
 * One attempt: the callback host is checked again (the delivery-time half of the SSRF check), then one signed POST, then the
 * outcome. The check and the POST are separate steps, so the window between them is the residual rebinding window recorded in
 * `events-webhook.ts`.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { BETTER_AUTH_SECRET } from "../env";
import { decryptKey } from "../lib/encryption";
import { encodeEventCursor } from "./events-cursor";
import { type CallbackHostCheck, checkCallbackHost } from "./events-webhook-address";
import { type CallbackFetch, eventBody, gapBody, messageIdOf, postOnce, type PostOutcome, terminatedBody, webhookHeaders } from "./events-webhook-wire";

export interface AttemptDependencies {
    fetch: CallbackFetch;
    resolve: (host: string) => Promise<CallbackHostCheck>;
}

/** One attempt at one URL: the address check, then one signed POST. A private host is refused without a request. */
export const attemptDelivery = async (input: {
    body: string;
    deps: AttemptDependencies;
    host: string;
    id: string;
    now: number;
    secret: string;
    subscriptionId: string;
    url: string;
}): Promise<PostOutcome> => {
    const address = await input.deps.resolve(input.host);

    if (address === "private") {
        return { category: "address_not_public", kind: "refused" };
    }

    if (address === "unresolved") {
        return { category: "connection_refused", kind: "failed" };
    }

    const headers = await webhookHeaders({
        body: input.body,
        id: input.id,
        secret: input.secret,
        subscriptionId: input.subscriptionId,
        timestampSeconds: Math.floor(input.now / 1000),
    });

    return await postOnce(input.url, headers, input.body, input.deps.fetch);
};

const liveDependencies = (): AttemptDependencies => {
    return {
        fetch: async (input, init) => await fetch(input, init),
        resolve: async (host) => await checkCallbackHost(host),
    };
};

const hostOf = (url: string): string => new URL(url).hostname;

/** Sends one queued delivery: claims it, makes the attempt, and records the outcome. */
export const sendDelivery = internalAction
    .input({ deliveryId: v.id("eventWebhookDeliveries") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const work = await ctx.runMutation(internal.public_api.event_webhook_deliveries.claimDelivery, { deliveryId: args.deliveryId });

        if (work === null) {
            return null;
        }

        const secret = await decryptKey(work.secretCiphertext, "tool-keys");
        const cursor = await encodeEventCursor(BETTER_AUTH_SECRET, work.userId, work.cursorSeq);
        const body =
            work.kind === "gap"
                ? gapBody(cursor)
                : eventBody({
                      cursor,
                      data: JSON.parse(work.data) as Record<string, unknown>,
                      eventId: work.eventId,
                      name: work.name,
                      timestamp: work.timestamp,
                  });

        const outcome = await attemptDelivery({
            body,
            deps: liveDependencies(),
            host: hostOf(work.url),
            id: work.webhookId,
            now: Date.now(),
            secret,
            subscriptionId: work.subscriptionId,
            url: work.url,
        });

        await ctx.runMutation(internal.public_api.event_webhook_deliveries.recordAttempt, { deliveryId: args.deliveryId, outcome });

        return null;
    });

/**
 * The `terminated` notice for a subscription whose host was removed from the allowlist. One attempt, and its outcome is not
 * retried: the subscription is already gone. The notice carries no event data.
 */
export const sendTerminated = internalAction
    .input({ secretCiphertext: v.string(), subscriptionId: v.string(), url: v.string(), userId: v.string() })
    .output(v.null())
    .action(async ({ args }) => {
        const secret = await decryptKey(args.secretCiphertext, "tool-keys");

        await attemptDelivery({
            body: terminatedBody("host_not_approved"),
            deps: liveDependencies(),
            host: hostOf(args.url),
            id: messageIdOf("terminated"),
            now: Date.now(),
            secret,
            subscriptionId: args.subscriptionId,
            url: args.url,
        });

        return null;
    });
