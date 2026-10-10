/**
 * Settings Resolution
 *
 * Resolves effective settings for a user based on organization and team context.
 * Handles inheritance: Team settings -> Organization settings -> Defaults
 */

import type { Doc, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";
import { getOrganization } from "./better-auth-queries";

// Sourced from the schema so the tier literals cannot drift from
// `organization.baseTier` (`v.union` of the same three literals).
type BillingTier = NonNullable<Doc<"organization">["baseTier"]>;

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

export interface UserEffectiveSettings {
    allowedModels: string[];
    credits: number;
    isEnterprise: boolean;
    tier: BillingTier;
}

/**
 * Gets the effective settings for a user based on their organization and optional team context.
 *
 * Resolution order:
 * 1. Member credit override (if set)
 * 2. Team allowed models (if in a team and team has custom settings)
 * 3. Organization settings
 * 4. Default settings based on tier.
 * @param context The query or mutation context
 */
export const getUserEffectiveSettings = async (
    context: QueryContext | MutationContext,
    userId: string,
    orgId: string,
    teamId?: string,
): Promise<UserEffectiveSettings> => {
    // Get organization
    const org = await getOrganization(context, orgId);

    if (!org) {
        // Default to free tier if org not found
        return {
            allowedModels: DEFAULT_ALLOWED_MODELS.free,
            credits: DEFAULT_CREDITS_PER_USER.free,
            isEnterprise: false,
            tier: "free",
        };
    }

    const baseTier = org.baseTier ?? "free";
    const orgCreditsPerUser = org.creditsPerUser ?? DEFAULT_CREDITS_PER_USER[baseTier];
    const orgAllowedModels = org.allowedModels ?? DEFAULT_ALLOWED_MODELS[baseTier];

    // Get member credits override
    const memberCredits = await context.db.memberCredits.findFirst({ where: { organizationId: orgId, userId } });

    const effectiveCredits = memberCredits?.creditOverride ?? orgCreditsPerUser;

    // Get team settings if team is specified
    let effectiveAllowedModels = orgAllowedModels;

    if (teamId) {
        const teamSettings = await context.db.teamSettings.findFirst({ where: { teamId } });

        if (teamSettings?.allowedModels && teamSettings.allowedModels.length > 0) {
            effectiveAllowedModels = teamSettings.allowedModels;
        }
    }

    return {
        allowedModels: effectiveAllowedModels,
        credits: effectiveCredits,
        isEnterprise: baseTier === "enterprise",
        tier: baseTier,
    };
};

/**
 * Checks if a specific model is allowed for a user based on their settings.
 * @param context The query or mutation context
 */
export const isModelAllowed = async (
    context: QueryContext | MutationContext,
    userId: string,
    orgId: string,
    teamId: string | undefined,
    model: string,
): Promise<boolean> => {
    const settings = await getUserEffectiveSettings(context, userId, orgId, teamId);

    // Enterprise with empty allowed models means all models are allowed
    if (settings.isEnterprise && settings.allowedModels.length === 0) {
        return true;
    }

    return settings.allowedModels.includes(model);
};

/**
 * Gets the default billing tier settings.
 * @param tier The billing tier
 * @returns The default settings for the tier
 */
export const getDefaultTierSettings = (tier: BillingTier): { allowedModels: string[]; credits: number } => {
    return {
        allowedModels: DEFAULT_ALLOWED_MODELS[tier],
        credits: DEFAULT_CREDITS_PER_USER[tier],
    };
};
