/**
 * Shared Authentication Types
 *
 * Canonical type definitions for session users and auth context.
 * Imported by auth/functions.ts, lib/crpc.ts, and lib/crpcAuthHelpers.ts.
 */

/**
 * Session user type with organization context.
 * Represents an authenticated user with their active organization membership.
 */
export type SessionUser = {
    activeOrganization: {
        id: string;
        name: string;
        role: string;
        slug: string | null;
    } | null;
    email: string;
    image?: string | null;
    impersonatedBy?: string | null;
    isAdmin: boolean;
    name: string;
    plan?: "premium" | null;
    role?: string | null;
    userId: string;
};

/**
 * Type guard for Better Auth user objects.
 */
const isBetterAuthUser = (
    user: unknown,
): user is {
    _id: string;
    activeOrganization?: {
        id: string;
        name: string;
        role?: string;
        slug?: string | null;
    } | null;
    banExpires?: number | null;
    banned?: boolean | null;
    banReason?: string | null;
    email?: string;
    image?: string | null;
    impersonatedBy?: string | null;
    name?: string;
    plan?: "premium" | null;
    role?: string | null;
} => typeof user === "object" && user !== null && "_id" in user && typeof user._id === "string";

/**
 * Ban status information.
 */
export interface BanStatus {
    expiresAt?: number;
    isBanned: boolean;
    reason?: string;
}

export default isBetterAuthUser;
