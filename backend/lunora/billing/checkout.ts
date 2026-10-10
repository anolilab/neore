/**
 * Creem checkout and the customer portal.
 *
 * Pro is bought by a user for themselves (reference = their user id); Team by
 * an organization owner for their active organization (reference =
 * the organization id, one seat per member). `billing/plans.ts` says why.
 *
 * Both go to the Creem ADAPTER (`ctx.payments.adapter`), not the facade's
 * `createCheckout` / `createPortalSession`: the facade authorizes with Lunora's
 * default rule (reference = the caller's own user id, `src/server.ts`), which a
 * Team reference — an organization — never meets. The checks here are the gate
 * instead (`billingOrganizationOf`, `portalCustomerFor`). Creem attaches the
 * checkout to the customer by e-mail, and the webhook stores the customer id
 * (and, for Team, the purchaser) on the user or organization row, which is
 * where the portal reads it.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { getOrganization, getUser } from "../auth/lib/better-auth-queries";
import { CREEM_API_KEY, CREEM_PRODUCT_PRO, CREEM_PRODUCT_TEAM, SITE_URL } from "../env";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { billingOrganizationOf, portalCustomerFor } from "./plans";

const TRAILING_SLASH = /\/$/u;

/** Where Creem sends the browser back to: the billing tab of the settings modal. */
const billingPageUrl = (): string => `${SITE_URL.replace(TRAILING_SLASH, "")}/chat?settings=true&settingsTab=auth-billing`;

const assertConfigured = (productId?: string): void => {
    if (!CREEM_API_KEY || productId === "") {
        throw new LunoraError("SERVICE_UNAVAILABLE", "Billing is not configured");
    }
};

const vSubject = v.union(
    v.object({ baseTier: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")), creemCustomerId: v.union(v.string(), v.null()) }),
    v.null(),
);

/** The billing columns of a user or organization row, and an organization's seat count. */
export const getBillingSubject = internalQuery
    .input({ id: v.string(), kind: v.union(v.literal("organization"), v.literal("user")) })
    .output(
        v.object({
            baseTier: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
            creemCustomerId: v.union(v.string(), v.null()),
            creemPurchaserId: v.union(v.string(), v.null()),
            creemSubscriptionId: v.union(v.string(), v.null()),
            exists: v.boolean(),
            isAnonymous: v.boolean(),
            seats: v.number(),
        }),
    )
    .query(async ({ args: { id, kind }, ctx }) => {
        if (kind === "user") {
            const user = await getUser(ctx, id);

            return {
                baseTier: user?.baseTier ?? "free",
                creemCustomerId: user?.creemCustomerId ?? null,
                creemPurchaserId: id,
                creemSubscriptionId: user?.creemSubscriptionId ?? null,
                exists: user !== null,
                isAnonymous: user?.isAnonymous === true,
                seats: 1,
            };
        }

        const [organization, members] = await Promise.all([getOrganization(ctx, id), ctx.db.member.count({ organizationId: id })]);

        return {
            baseTier: organization?.baseTier ?? "free",
            creemCustomerId: organization?.creemCustomerId ?? null,
            creemPurchaserId: organization?.creemPurchaserId ?? null,
            creemSubscriptionId: organization?.creemSubscriptionId ?? null,
            exists: organization !== null,
            isAnonymous: false,
            seats: Math.max(1, members),
        };
    });

/** The caller's own plan, for the billing settings: Pro or not, and whether there is a subscription to manage. */
export const getMyPlan = authQuery.output(v.from(vSubject)).query(async ({ ctx }) => {
    const user = await getUser(ctx, ctx.user.userId);

    return user ? { baseTier: user.baseTier ?? "free", creemCustomerId: user.creemCustomerId ?? null } : null;
});

/**
 * The Team plans the caller pays for, with each organization's member count —
 * for the delete-account dialog, which warns that deleting the account cancels
 * them (`gdpr/steps/residual-deletion-steps.ts`, `teamBillingOnAccountDeletion`).
 */
export const getTeamPlansIPay = authQuery
    .output(v.array(v.object({ memberCount: v.number(), name: v.string(), organizationId: v.string() })))
    .query(async ({ ctx }) => {
        const { page } = await ctx.db.organization.findMany({ limit: 50, where: { creemPurchaserId: ctx.user.userId } });
        const paying = page.filter((organization) => organization.creemSubscriptionId !== undefined && (organization.baseTier ?? "free") !== "free");

        return await Promise.all(
            paying.map(async (organization) => {
                return {
                    memberCount: await ctx.db.member.count({ organizationId: organization._id }),
                    name: organization.name,
                    organizationId: organization._id,
                };
            }),
        );
    });

/**
 * Start a Creem checkout and return the hosted checkout URL to redirect to.
 * `pro`: for the caller, any signed-in (non-guest) user. `team`: for the
 * caller's active organization, owner only, billed per member.
 */
export const createCheckout = authAction
    .use(rateLimit("billing/checkout"))
    .input({ plan: v.union(v.literal("pro"), v.literal("team")) })
    .output(v.object({ url: v.string() }))
    .action(async ({ args: { plan }, ctx }) => {
        const productId = plan === "pro" ? CREEM_PRODUCT_PRO : CREEM_PRODUCT_TEAM;

        assertConfigured(productId);

        const referenceId = plan === "pro" ? ctx.user.userId : billingOrganizationOf(ctx.user);
        const subject = await ctx.runQuery(internal.billing.checkout.getBillingSubject, { id: referenceId, kind: plan === "pro" ? "user" : "organization" });

        if (!subject.exists || subject.isAnonymous) {
            throw new LunoraError("FORBIDDEN", "Create an account to subscribe");
        }

        if (subject.baseTier !== "free") {
            throw new LunoraError("CONFLICT", plan === "pro" ? "You already have Pro" : "This organization is already on a paid plan");
        }

        // The opening seat count; `billing/seats.ts` keeps it in step with membership after.
        const { url } = await ctx.payments.adapter.createCheckout({
            // Read back by the webhook (`subscriptionEventOf`) as the organization's purchaser.
            metadata: { purchaserId: ctx.user.userId },
            mode: "subscription",
            priceId: productId,
            quantity: subject.seats,
            referenceId,
            successUrl: billingPageUrl(),
        });

        ctx.log.event("billing.create_checkout", { plan, seats: subject.seats });

        return { url };
    });

/**
 * Open Creem's customer portal (payment method, invoices, cancel) for the
 * caller's own Pro (`user`) or their active organization's Team plan
 * (`organization`, only the owner who subscribed). Fails when that subject never
 * subscribed, so there is no Creem customer to open.
 */
export const openCustomerPortal = authAction
    .use(rateLimit("billing/checkout"))
    .input({ subject: v.union(v.literal("organization"), v.literal("user")) })
    .output(v.object({ url: v.string() }))
    .action(async ({ args: { subject: kind }, ctx }) => {
        assertConfigured();

        const id = kind === "user" ? ctx.user.userId : billingOrganizationOf(ctx.user);
        const { creemCustomerId, creemPurchaserId } = await ctx.runQuery(internal.billing.checkout.getBillingSubject, { id, kind });

        const session = await ctx.payments.adapter.createPortalSession({
            customerId: portalCustomerFor(ctx.user.userId, { creemCustomerId, creemPurchaserId }),
            referenceId: id,
            returnUrl: billingPageUrl(),
        });

        ctx.log.event("billing.open_customer_portal", { subject: kind });

        return session;
    });
