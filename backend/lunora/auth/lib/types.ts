/**
 * Better Auth type definitions.
 *
 * `organization`, `member`, `invitation` and `user` ARE tables in
 * `lunora/schema.ts`, so their row types are the generated `Doc<...>` — do NOT
 * hand-write them again. The aliases below exist only so the runtime type guards
 * in `./typeGuards.ts` keep a stable name; new code should import `Doc` directly.
 *
 * The earlier hand-written interfaces were wrong in both directions: they
 * promised `monthlyCredits: number` / `slug: string | null` for columns that are
 * `v.optional`, and omitted `baseTier`, `creditsPerUser`, `allowedModels`,
 * `billingEmail`, `creemCustomerId` and `creemSubscriptionId` entirely.
 */

import type { Doc } from "../../_generated/dataModel";

/**
 * Better Auth user object as assembled from the auth identity.
 *
 * NOT a `Doc<"user">`: `getCurrentUserInternal()` builds this from the JWT
 * identity plus an organization lookup, so it is a DTO rather than a row.
 * There is deliberately no `username` — the `user` table has no such column and
 * no better-auth username plugin is configured, so it was always `undefined`.
 */
export interface BetterAuthUser {
    _id: string;
    activeOrganization?: {
        id: string;
        name: string;
        role: string;
        slug?: string | null;
    } | null;
    email: string;
    image?: string | null;
    impersonatedBy?: string | null;
    isAnonymous?: boolean;
    name: string | null;
    /** `"premium"` while the active organization is on a paid tier (`auth/lib/plan.ts`). */
    plan?: "premium" | null;
    role?: string | null;
}

/** Row type of the `organization` table. */
export type BetterAuthOrganization = Doc<"organization">;

/** Row type of the `member` table (organization membership). */
export type BetterAuthMember = Doc<"member">;

/** Row type of the `invitation` table. */
export type BetterAuthInvitation = Doc<"invitation">;
