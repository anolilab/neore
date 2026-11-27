/**
 * Creem webhooks: `POST /billing/creem/webhook` (`http.ts`) forwards the raw
 * body and the signature header here, on `__root__`, where `ctx.payments`
 * verifies the signature and applies the event to the payment store.
 *
 * The tier side effect then READS the stored subscription instead of trusting
 * the event: the store's state machine has already dropped duplicates and
 * out-of-order deliveries, so writing the tier from its result converges on
 * the right answer however often Creem redelivers — re-running it is harmless.
 */
import { webhookResponse } from "@lunora/payment";
import type { HttpActionCtx } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { CREEM_WEBHOOK_SECRET } from "../env";
import { logger } from "../lib/logger";
import { jobSubject } from "./authorize";
import { continueErasure, deleteAllBillingRows, endLiveSubscriptions } from "./gdpr";
import { subscriptionUpdateOf } from "./plans";
import { planProducts } from "./products";

const billingLogger = logger.scope("billing");

/** States that grant the subject its plan, so the customer recorded for them is the one that pays. */
const ENTITLING_STATES: ReadonlySet<string> = new Set(["active", "past_due", "trialing"]);

/** `customer` / `subscription` arrive as an id or as the expanded object. */
const idOf = (value: unknown): string | undefined => {
    const id = typeof value === "string" ? value : (value as { id?: unknown } | null | undefined)?.id;

    return typeof id === "string" ? id : undefined;
};

/**
 * The subscription, customer and purchaser a verified Creem event names: a
 * `subscription.*` event, or the `checkout.completed` that started one — which
 * is where Lunora adopts a subscription whose events arrived first and had no
 * reference yet, so the tier is written on whichever of the two lands last.
 */
export const subscriptionEventOf = (body: string): { customerId?: string; purchaserId?: string; subscriptionId: string } | undefined => {
    const event = JSON.parse(body) as {
        eventType?: unknown;
        object?: { customer?: unknown; id?: unknown; metadata?: { purchaserId?: unknown }; subscription?: unknown };
    };

    if (typeof event.eventType !== "string" || !event.object) {
        return undefined;
    }

    let subscriptionId: string | undefined;

    if (event.eventType === "checkout.completed") {
        subscriptionId = idOf(event.object.subscription);
    } else if (event.eventType.startsWith("subscription.")) {
        subscriptionId = idOf(event.object.id);
    }

    if (subscriptionId === undefined) {
        return undefined;
    }

    // The owner who paid, carried from the checkout's metadata (`checkout.ts`).
    const purchaserId = event.object.metadata?.purchaserId;

    return {
        customerId: idOf(event.object.customer),
        purchaserId: typeof purchaserId === "string" ? purchaserId : undefined,
        subscriptionId,
    };
};

export const processCreemWebhook = internalAction
    .input({ body: v.string(), signature: v.string() })
    .output(v.object({ applied: v.boolean(), status: v.number() }))
    .action(async ({ args: { body, signature }, ctx }) => {
        const response = await ctx.payments.handleWebhook(
            new Request("https://internal/billing/creem/webhook", { body, headers: { "creem-signature": signature }, method: "POST" }),
        );
        const payload: unknown = await response.json();
        const applied = typeof payload === "object" && payload !== null && "applied" in payload && payload.applied === true;

        // Anything but 200 is a bad signature or an event Creem must redeliver; the tier waits for it.
        if (response.status !== 200) {
            return { applied, status: response.status };
        }

        const event = subscriptionEventOf(body);

        if (!event) {
            return { applied, status: response.status };
        }

        const subscription = await ctx.payments.store.getSubscription("creem", event.subscriptionId);

        // No reference yet: its `checkout.completed` has not arrived, and writes the tier when it does.
        if (subscription?.referenceId === "") {
            return { applied, status: response.status };
        }

        // The facade has just stored rows for this event. For an erased reference the subscription may still bill, so it is
        // ended at Creem first, and the rows go only after that is confirmed. A failed cancel throws: the event is refused,
        // Creem redelivers it, and the rows are still there to retry against.
        if (subscription && (await ctx.runQuery(internal.billing.gdpr.isErased, { referenceId: subscription.referenceId }))) {
            await endLiveSubscriptions(ctx.payments.scoped(jobSubject(subscription.referenceId)), [subscription]);
            const complete = await deleteAllBillingRows(
                async () => await ctx.runMutation(internal.billing.gdpr.deleteBillingRows, { erase: true, referenceId: subscription.referenceId }),
            );

            if (!complete) {
                await continueErasure(subscription.referenceId, true);
            }

            return { applied, status: response.status };
        }

        const update = subscription ? subscriptionUpdateOf(subscription, event, planProducts()) : undefined;

        if (update && subscription) {
            await ctx.runMutation(internal.auth.billing.applyCreemSubscription, update);

            // The portal opens on the customer recorded for the subject. Seed it from the paid subscription: the mutation
            // refuses a customer another reference owns, and refuses an erased reference.
            if (event.customerId !== undefined && ENTITLING_STATES.has(subscription.state)) {
                await ctx.runMutation(internal.billing.customers.seedCustomer, { customerId: event.customerId, referenceId: subscription.referenceId });
            }
        } else {
            billingLogger.warn("Creem subscription event grants nothing here", { priceId: subscription?.priceId, subscriptionId: event.subscriptionId });
        }

        return { applied, status: response.status };
    });

/**
 * `POST /billing/creem/webhook`. Runs in the Worker, so its `runAction` lands
 * on `__root__` — where the payment store's rows live. `webhookResponse`
 * re-applies the status `handleWebhook` chose (a 500 asks Creem to redeliver).
 */
export const handleCreemWebhook = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    if (!CREEM_WEBHOOK_SECRET) {
        return Response.json({ error: "Billing is not configured" }, { status: 503 });
    }

    const body = await request.text();
    const signature = request.headers.get("creem-signature") ?? "";

    return webhookResponse(await context.runAction(internal.billing.webhook.processCreemWebhook, { body, signature }));
};
