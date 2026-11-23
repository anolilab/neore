/**
 * The Events webhook sender (part 2b): the internal actions the jobs queue runs, and one attempt around one POST. Actions are where
 * outbound calls belong; the claim and the outcome are mutations on the owner's shard (`event-webhook-deliveries.ts`).
 *
 * One attempt is one signed POST through `liveCallbackRequest`, which checks the callback's address when it connects. There is no
 * separate check before it, so nothing sits between the check and the request for a name to change in.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { BETTER_AUTH_SECRET } from "../env";
import { decryptKey } from "../lib/encryption";
import { encodeEventCursor } from "./events-cursor";
import { liveCallbackRequest } from "./events-webhook-request";
import { type CallbackRequest, eventBody, gapBody, messageIdOf, postOnce, type PostOutcome, terminatedBody, webhookHeaders } from "./events-webhook-wire";

/** One attempt at one URL: one signed POST, classed. The request checks the address; a refused address is a refusal. */
export const attemptDelivery = async (input: {
    body: string;
    id: string;
    now: number;
    request: CallbackRequest;
    secret: string;
    subscriptionId: string;
    url: string;
}): Promise<PostOutcome> => {
    const headers = await webhookHeaders({
        body: input.body,
        id: input.id,
        secret: input.secret,
        subscriptionId: input.subscriptionId,
        timestampSeconds: Math.floor(input.now / 1000),
    });

    return await postOnce(input.url, headers, input.body, input.request);
};

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
            id: work.webhookId,
            now: Date.now(),
            request: liveCallbackRequest,
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
            id: messageIdOf("terminated"),
            now: Date.now(),
            request: liveCallbackRequest,
            secret,
            subscriptionId: args.subscriptionId,
            url: args.url,
        });

        return null;
    });
