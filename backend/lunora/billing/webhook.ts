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
import { CREEM_PRODUCT_PRO, CREEM_PRODUCT_TEAM, CREEM_WEBHOOK_SECRET } from "../env";
import { logger } from "../lib/logger";
import { subscriptionUpdateOf } from "./plans";

const billingLogger = logger.scope("billing");

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

        const update = subscription ? subscriptionUpdateOf(subscription, event, { pro: CREEM_PRODUCT_PRO, team: CREEM_PRODUCT_TEAM }) : undefined;

        if (update) {
            await ctx.runMutation(internal.auth.billing.applyCreemSubscription, update);
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
