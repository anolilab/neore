/**
 * The payment store's customer for a subject, written from the paid Creem subscription.
 *
 * Checkout binds a customer only when Creem can bind the buyer's email to one, so the subject's
 * customer is sometimes missing, and sometimes points at a customer that a later subscription
 * replaced. The webhook and the portal both write it through {@link seedCustomer}, so the portal
 * always opens on the customer billing recorded for the subject.
 *
 * It is one mutation, so the erased-reference check and the customer write are one transaction:
 * account deletion cannot interleave between them and leave the customer row behind.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";

/** Rows read per reference. Concurrent first checkouts can leave a few; more than this is not a state the store produces. */
const SEED_ROWS = 50;

/**
 * Point `referenceId`'s Creem customer at `customerId`, unless that would break the store's rules:
 * the reference was erased, or another reference already owns the customer. Returns whether it did.
 */
export const seedCustomer = internalMutation
    .input({ customerId: v.string(), referenceId: v.string() })
    .output(v.object({ seeded: v.boolean() }))
    .mutation(async ({ args: { customerId, referenceId }, ctx }) => {
        if (await ctx.db.billingErasures.findFirst({ where: { referenceId } })) {
            return { seeded: false };
        }

        const owner = await ctx.db.payment_customers.findFirst({ where: { provider: "creem", providerCustomerId: customerId } });

        if (owner && owner.referenceId !== referenceId) {
            return { seeded: false };
        }

        // Concurrent first checkouts can leave several rows for one reference, and the reader takes the first. Keep the row that
        // already holds `customerId`, or else the first one, and drop the rest. Only then point the kept row at `customerId`:
        // never at an id another row holds, which the unique index refuses.
        const { page: rows } = await ctx.db.payment_customers.findMany({ limit: SEED_ROWS, where: { provider: "creem", referenceId } });
        const kept = rows.find((row) => row.providerCustomerId === customerId) ?? rows[0];

        for (const row of rows) {
            if (row !== kept) {
                await ctx.db.delete("payment_customers", row._id);
            }
        }

        if (!kept) {
            await ctx.db.insert("payment_customers", { createdAt: Date.now(), provider: "creem", providerCustomerId: customerId, referenceId });
        } else if (kept.providerCustomerId !== customerId) {
            await ctx.db.patch("payment_customers", kept._id, { providerCustomerId: customerId });
        }

        return { seeded: true };
    });
