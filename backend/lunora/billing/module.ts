import { defineModule } from "lunorash/server";

export default defineModule({
    description:
        "Creem subscriptions: per-user Pro and per-organization Team checkout, customer portal, Team seat sync and the webhook that sets the tier. Owns the `@lunora/payment` store tables.",
    tables: ["payment_customers", "payment_events", "payment_sessions", "payment_subscriptions", "payment_usageEvents"],
});
