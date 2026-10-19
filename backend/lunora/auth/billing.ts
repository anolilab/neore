import type { Infer } from "lunorash/server";

/**
 * Billing functions for organization billing settings and member credits.
 *
 * Payments run through Creem (`billing/`): checkout and the customer portal,
 * and a webhook that lands here as `applyCreemSubscription` to set the
 * organization's tier. This file holds the application-level settings (tier,
 * credits, models) that tier drives.
 */
import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { adminMutation, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { getMemberByOrganizationAndUser, getOrganization, getUser } from "./lib/better-auth-queries";
import { getUserEffectiveSettings } from "./lib/settings-resolver";
import { resolveUserPlan } from "./lib/plan";
import { computeGatewayCredits, vBillingMode } from "./lib/gateway-credits";
import { applyGatewayDeduction } from "./lib/gateway-deduction";
import { creemTierPatch } from "../billing/plans";
import { authLogger } from "../lib/logger";
import { patchRow, withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";

/** Valid billing tiers. */
type BillingTier = "free" | "pro" | "enterprise";

/**
 * `v` has no `enum`, so the tier union is spelled out — and it is spelled out at
 * each use site rather than hoisted to a shared const, because codegen resolves an
 * INLINE validator expression but not a bare const reference.
 * Hoisting it produced `baseTier: unknown` in `_generated/api.ts`, which then
 * surfaced in `apps/web` as `Type '{}' is not assignable to type 'ReactNode'`.
 */

// Default credits per user for each tier
const DEFAULT_CREDITS_PER_USER: Record<BillingTier, number> = {
    enterprise: 10_000,
    free: 100,
    pro: 1000,
};

// Default allowed models for each tier
const DEFAULT_ALLOWED_MODELS: Record<BillingTier, string[]> = {
    enterprise: [], // Empty means all models allowed
    free: ["gemini-1.5-flash", "claude-3-haiku-20240307"],
    pro: ["gemini-1.5-flash", "gemini-1.5-pro", "claude-3-haiku-20240307", "claude-3-5-sonnet-20241022", "gpt-4o-mini"],
};

/**
 * Get billing information for the active organization.
 */
export const getBillingInfo = authQuery
    .output(
        v.union(
            v.object({
                allowedModels: v.array(v.string()),
                baseTier: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
                billingEmail: v.union(v.string(), v.null()),
                creditsPerUser: v.number(),
                creemCustomerId: v.optional(v.union(v.string(), v.null())),
                creemSubscriptionId: v.optional(v.union(v.string(), v.null())),
            }),
            v.null(),
        ),
    )
    .query(async ({ ctx: context }) => {
        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            return null;
        }

        const org = await getOrganization(context, orgId);

        if (!org) {
            return null;
        }

        const baseTier: BillingTier = org.baseTier ?? "free";

        // `baseTier` spelled out rather than `BillingTier`. Codegen prints this
        // annotation verbatim into `_generated/api.ts` WITHOUT the import, so a
        // local alias here becomes `Cannot find name` there. Exporting the alias fixes that and costs 59 unrelated `TS4023:
        // has or is using name … from external module` errors elsewhere, so the
        // name is kept out of the printed type instead.
        const result: {
            allowedModels: string[];
            baseTier: "enterprise" | "free" | "pro";
            billingEmail: string | null;
            creditsPerUser: number;
            creemCustomerId?: string | null;
            creemSubscriptionId?: string | null;
        } = {
            allowedModels: org.allowedModels ?? DEFAULT_ALLOWED_MODELS[baseTier],
            baseTier,
            billingEmail: org.billingEmail ?? null,
            creditsPerUser: org.creditsPerUser ?? DEFAULT_CREDITS_PER_USER[baseTier],
        };

        // Only expose the Creem ids to organization owners
        const memberRole = context.user.activeOrganization?.role;

        if (memberRole === "owner") {
            result.creemCustomerId = org.creemCustomerId ?? null;
            result.creemSubscriptionId = org.creemSubscriptionId ?? null;
        }

        return result;
    });

/**
 * Get member credits information for a specific user in the active organization.
 * Returns the credit override (if any) and usage information.
 */
const vGetMemberCreditsOutput = v.union(
    v.object({
        creditOverride: v.union(v.number(), v.null()),
        effectiveCredits: v.number(),
        orgDefault: v.number(),
        resetAt: v.union(v.number(), v.null()),
        usedCredits: v.number(),
        userId: v.string(),
    }),
    v.null(),
);

export const getMemberCredits = authQuery
    .input({
        userId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.from(vGetMemberCreditsOutput))
    .query(async ({ args: { userId }, ctx: context }): Promise<Infer<typeof vGetMemberCreditsOutput>> => {
        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            return null;
        }

        const targetUserId = userId ?? context.user.userId;
        const orgRole = context.user.activeOrganization?.role;

        // Another member's credits are an owner/admin view (`listMemberCredits`).
        if (targetUserId !== context.user.userId && orgRole !== "owner" && orgRole !== "admin") {
            throw new LunoraError("FORBIDDEN", "Only organization owners and admins can view other members' credits");
        }

        // Get the member credits record
        const memberCredits = await context.db.memberCredits.findFirst({ where: { organizationId: orgId, userId: targetUserId } });

        // Get organization defaults
        const org = await getOrganization(context, orgId);
        const baseTier: BillingTier = org?.baseTier ?? "free";
        const orgCreditsPerUser = org?.creditsPerUser ?? DEFAULT_CREDITS_PER_USER[baseTier];

        return {
            creditOverride: memberCredits?.creditOverride ?? null,
            effectiveCredits: memberCredits?.creditOverride ?? orgCreditsPerUser,
            orgDefault: orgCreditsPerUser,
            resetAt: memberCredits?.resetAt ?? null,
            usedCredits: memberCredits?.usedCredits ?? 0,
            userId: targetUserId,
        };
    });

/**
 * Update the active organization's own billing preferences: contact e-mail and
 * the allowed-model list. Owner only.
 *
 * The TIER and credit allowance are deliberately not here. They are what the
 * customer pays for — the tier is set by the Creem webhook
 * (`applyCreemSubscription`) — so an owner setting them would be granting
 * themselves a plan; anyone can create an org and own it. Beyond the webhook
 * they are platform-admin operations: `setOrganizationBillingTier` and
 * `setMemberCreditOverride`.
 */
export const updateBillingSettings = authMutation
    .use(rateLimit("billing/update"))
    .input({
        allowedModels: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
        billingEmail: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .mutation(async ({ args, ctx: context }) => {
        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        const orgRole = context.user.activeOrganization?.role;

        // Only owners can update billing settings
        if (orgRole !== "owner") {
            throw new LunoraError("FORBIDDEN", "Only organization owners can update billing settings");
        }

        const organizationId = context.db.asId("organization", orgId);
        const org = await context.db.organization.findFirst({ where: { _id: organizationId } });

        if (!org) {
            throw new LunoraError("NOT_FOUND", "Organization not found");
        }

        const updates: { allowedModels?: string[]; billingEmail?: string } = {};

        if (args.allowedModels !== undefined) {
            updates.allowedModels = args.allowedModels;
        }

        if (args.billingEmail !== undefined) {
            updates.billingEmail = args.billingEmail;
        }

        if (Object.keys(updates).length > 0) {
            await context.db.patch(organizationId, withoutUndefined(updates));
        }

        context.log.event("billing.update_billing_settings", {
            organizationId: orgId,
            updatedAllowedModels: args.allowedModels !== undefined,
            updatedBillingEmail: args.billingEmail !== undefined,
        });
    });

/**
 * Set an organization's billing tier and per-user credit allowance.
 * PLATFORM ADMIN only — see `updateBillingSettings` for why.
 */
export const setOrganizationBillingTier = adminMutation
    .use(rateLimit("billing/update"))
    .input({
        baseTier: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        creditsPerUser: v.optional(
            v.number().check((n) => Number.isFinite(n) && n >= 0, { message: "creditsPerUser must be >= 0", schema: { minimum: 0, type: "number" } }),
        ),
        organizationId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const organizationId = context.db.asId("organization", args.organizationId);
        const org = await context.db.organization.findFirst({ where: { _id: organizationId } });

        if (!org) {
            throw new LunoraError("NOT_FOUND", "Organization not found");
        }

        const updates = withoutUndefined({ baseTier: args.baseTier, creditsPerUser: args.creditsPerUser });

        if (Object.keys(updates).length > 0) {
            await context.db.patch(organizationId, updates);
        }

        context.log.event("billing.set_organization_billing_tier", {
            baseTier: args.baseTier,
            organizationId,
            updatedCreditsPerUser: args.creditsPerUser !== undefined,
        });

        return null;
    });

/**
 * Write the tier a Creem subscription grants onto its subject
 * (`billing/webhook.ts`): the buyer's user row for Pro, the organization for
 * Team. The rule is `billing/plans.ts#creemTierPatch`. Idempotent: the values
 * come from the stored subscription, so a redelivered event writes the same
 * row again.
 */
export const applyCreemSubscription = internalMutation
    .input({
        baseTier: v.union(v.literal("free"), v.literal("pro")),
        creemCustomerId: v.optional(v.string()),
        creemPurchaserId: v.optional(v.string()),
        creemSubscriptionId: v.string(),
        referenceId: v.string(),
        subject: v.union(v.literal("organization"), v.literal("user")),
    })
    .output(v.null())
    .mutation(async ({ args: { referenceId, subject, ...update }, ctx: context }) => {
        const row = subject === "user" ? await getUser(context, referenceId) : await getOrganization(context, referenceId);

        if (!row) {
            authLogger.warn("Creem subscription names no row", { referenceId, subject, subscriptionId: update.creemSubscriptionId });

            return null;
        }

        const patch = creemTierPatch(row, update);

        if (patch) {
            await context.db.patch(row._id, patch);
        }

        return null;
    });

/**
 * Set a credit override for a member of an organization.
 * PLATFORM ADMIN only: an override is a credit grant, and org admins could
 * otherwise grant themselves any allowance.
 */
export const setMemberCreditOverride = adminMutation
    .use(rateLimit("billing/update"))
    .input({
        creditOverride: v.union(v.number(), v.null()),
        organizationId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args: { creditOverride, organizationId: orgId, userId }, ctx: context }) => {
        // Verify the target user is a member of the organization
        const member = await getMemberByOrganizationAndUser(context, orgId, userId);

        if (!member) {
            throw new LunoraError("NOT_FOUND", "User is not a member of this organization");
        }

        // Find existing member credits record
        const existingCredits = await context.db.memberCredits.findFirst({ where: { organizationId: orgId, userId } });

        if (existingCredits) {
            // Update existing record
            if (creditOverride === null) {
                // Remove the override: `undefined` makes `patchRow` drop the field.
                await patchRow(context.db, existingCredits, {
                    creditOverride: undefined,
                });
            } else {
                await context.db.patch(existingCredits._id, {
                    creditOverride,
                });
            }
        } else if (creditOverride !== null) {
            // Create new record only if setting an override
            await context.db.insert("memberCredits", {
                creditOverride,
                memberId: member._id,
                organizationId: orgId,
                usedCredits: 0,
                userId,
            });
        }

        context.log.event("billing.set_member_credit_override", { cleared: creditOverride === null, organizationId: orgId, userId });
    });

/**
 * The credits a member has left for an organization, or `null` when they have no record. No record is
 * not charged (`applyGatewayDeduction`), so there is no balance to refuse on. Read by the workflow's video
 * pre-check, which must agree with what the deduction will do.
 */
export const creditsLeftQuery = internalQuery
    .input({ orgId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ creditsLeft: v.union(v.number(), v.null()) }))
    .query(async ({ args: { orgId, userId }, ctx: context }) => {
        const record = await context.db.memberCredits.findFirst({ where: { organizationId: orgId, userId } });

        if (!record) {
            return { creditsLeft: null };
        }

        const settings = await getUserEffectiveSettings(context, userId, orgId);

        return { creditsLeft: settings.credits - (record.usedCredits ?? 0) };
    });

/**
 * The run plan for a run acting in one organization: its paid tier when the user is still a member, or the
 * user's own Pro, or `null` for a personal run (`organizationId: null`). Admins run any model. The same
 * organization decides the gate, the quota and the credits, so none of them can disagree.
 */
export const getRunPlanForOrganizationQuery = internalQuery
    .input({ organizationId: v.union(v.string().max(MAX_LENGTH.id), v.null()), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ isAdmin: v.boolean(), plan: v.union(v.literal("premium"), v.null()) }))
    .query(async ({ args: { organizationId, userId }, ctx: context }) => {
        const user = await getUser(context, userId);
        const membership = organizationId ? await getMemberByOrganizationAndUser(context, organizationId, userId) : null;
        const organization = membership && organizationId ? await getOrganization(context, organizationId) : null;

        return { isAdmin: user?.role === "admin", plan: resolveUserPlan(user, [organization]) };
    });

export const deductCreditsFromGateway = internalMutation
    .input({
        billingMode: v.optional(v.from(vBillingMode)),
        byokFeeRate: v.optional(v.number()),
        costMicrodollars: v.number(),
        modelId: v.string(),
        orgId: v.optional(v.string()),
        requestId: v.string(),
        userId: v.string(),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Idempotent on `requestId` — the gateway retries usage reports.
        await applyGatewayDeduction(context, args);
    });

/**
 * Takes a platform run's clip cost from the member's credits before the paid call, and refuses when they
 * have fewer left. The check and the deduction are one mutation, so two runs cannot both pass on the same
 * balance. The deduction is the one `deductCreditsFromGateway` makes, keyed on `requestId`, so the charge
 * made after the run is then a no-op. `"refused"` is a refusal. `"already"` means this request id was reserved by an earlier attempt,
 * so this attempt took nothing and must not give anything back. No organization or no credit record is not refused, as in chat.
 */
export const reserveGatewayCredits = internalMutation
    .input({
        costMicrodollars: v.number().check((value) => value >= 0, { message: "Negative cost" }),
        modelId: v.string().max(MAX_LENGTH.short),
        orgId: v.string().max(MAX_LENGTH.id),
        requestId: v.string().max(MAX_LENGTH.long),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.union(v.literal("taken"), v.literal("already"), v.literal("refused")))
    .mutation(async ({ args, ctx: context }) => {
        const prior = await context.db
            .query("gatewayUsageDeductions")
            .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
            .first();

        if (prior) {
            return "already";
        }

        const record = await context.db.memberCredits.findFirst({ where: { organizationId: args.orgId, userId: args.userId } });

        if (record) {
            const settings = await getUserEffectiveSettings(context, args.userId, args.orgId);
            const credits = computeGatewayCredits({ billingMode: "platform", costMicrodollars: args.costMicrodollars });

            if (credits > settings.credits - (record.usedCredits ?? 0)) {
                return "refused";
            }
        }

        await applyGatewayDeduction(context, { ...args, billingMode: "platform" });

        return "taken";
    });

/**
 * Gives back a reservation from `reserveGatewayCredits` whose paid work produced no clip: removes its ledger
 * row and the credits it took. With no row (never taken, or already released) it does nothing.
 */
export const releaseGatewayCredits = internalMutation
    .input({ requestId: v.string().max(MAX_LENGTH.long) })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const row = await context.db
            .query("gatewayUsageDeductions")
            .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
            .first();

        if (!row) {
            return null;
        }

        const record = await context.db.memberCredits.findFirst({ where: { organizationId: row.orgId, userId: row.userId } });

        if (record) {
            await context.db.patch(record._id, { usedCredits: Math.max((record.usedCredits ?? 0) - row.creditsDeducted, 0) });
        }

        await context.db.delete(row._id);

        return null;
    });

/**
 * Get the list of members with their credit information for the active organization.
 * Useful for the admin UI to show all members and their credit status.
 */
const vListMemberCreditsOutput = v.array(
    v.object({
        creditOverride: v.union(v.number(), v.null()),
        effectiveCredits: v.number(),
        role: v.string(),
        usedCredits: v.number(),
        userEmail: v.union(v.string(), v.null()),
        userId: v.string(),
        userName: v.union(v.string(), v.null()),
    }),
);

export const listMemberCredits = authQuery
    .output(v.from(vListMemberCreditsOutput))
    .query(async ({ ctx: context }): Promise<Infer<typeof vListMemberCreditsOutput>> => {
        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            return [];
        }

        const orgRole = context.user.activeOrganization?.role;

        // Only owners and admins can view all member credits
        if (orgRole !== "owner" && orgRole !== "admin") {
            return [];
        }

        // Get organization defaults
        const org = await getOrganization(context, orgId);
        const baseTier: BillingTier = org?.baseTier ?? "free";
        const orgCreditsPerUser = org?.creditsPerUser ?? DEFAULT_CREDITS_PER_USER[baseTier];

        // Get all members
        const { page: members } = await context.db.member.findMany({ where: { organizationId: orgId } });

        // Get all member credits for this org
        const { page: allCredits } = await context.db.memberCredits.findMany({ where: { organizationId: orgId } });

        // Create a map of userId -> credits
        const creditsMap = new Map(allCredits.map((c) => [c.userId, c]));

        // Combine member info with credits
        const result = await Promise.all(
            members.map(async (member) => {
                const user = await context.db.user.findFirst({ where: { _id: context.db.asId("user", member.userId) } });
                const credits = creditsMap.get(member.userId);

                return {
                    creditOverride: credits?.creditOverride ?? null,
                    effectiveCredits: credits?.creditOverride ?? orgCreditsPerUser,
                    role: member.role,
                    usedCredits: credits?.usedCredits ?? 0,
                    userEmail: user?.email ?? null,
                    userId: member.userId,
                    userName: user?.name ?? null,
                };
            }),
        );

        return result;
    });
