import { LunoraError } from "lunorash/server";

import type { BetterAuthInvitation, BetterAuthMember, BetterAuthOrganization, BetterAuthUser } from "./types";

/**
 * Type guard to check if a value is a BetterAuthUser.
 */
export const isBetterAuthUser = (user: unknown): user is BetterAuthUser => {
    if (!user || typeof user !== "object") {
        return false;
    }

    const candidate = user as { _id?: unknown; email?: unknown };

    return typeof candidate._id === "string" && typeof candidate.email === "string";
};

/**
 * Assert that a value is a BetterAuthUser, throwing if not.
 */
export function assertBetterAuthUser(user: unknown): asserts user is BetterAuthUser {
    if (!isBetterAuthUser(user)) {
        throw new LunoraError("INTERNAL_ERROR", "Invalid user object: missing required fields");
    }
}

/**
 * Type guard to check if a user has an _id field.
 */
export const hasBetterAuthId = (user: unknown): user is { _id: string } => {
    if (!user || typeof user !== "object") {
        return false;
    }

    return "_id" in user && typeof (user as { _id?: unknown })._id === "string";
};

/**
 * Extract user ID from a Better Auth user object
 * Handles both _id and id fields for compatibility.
 */
export const extractUserId = (user: unknown): string | null => {
    if (!user || typeof user !== "object") {
        return null;
    }

    const candidate = user as { _id?: unknown; id?: unknown };

    // Try _id first
    if (typeof candidate._id === "string") {
        return candidate._id;
    }

    // Fallback to id (Better Auth format)
    if (typeof candidate.id === "string") {
        return candidate.id;
    }

    return null;
};

/**
 * Type guard for Better Auth organization.
 */
export const isBetterAuthOrganization = (org: unknown): org is BetterAuthOrganization => {
    if (!org || typeof org !== "object") {
        return false;
    }

    const candidate = org as { _id?: unknown; monthlyCredits?: unknown; name?: unknown };

    return typeof candidate._id === "string" && typeof candidate.name === "string" && typeof candidate.monthlyCredits === "number";
};

/**
 * Type guard for Better Auth member.
 */
export const isBetterAuthMember = (member: unknown): member is BetterAuthMember => {
    if (!member || typeof member !== "object") {
        return false;
    }

    const candidate = member as { _id?: unknown; organizationId?: unknown; role?: unknown; userId?: unknown };

    return (
        typeof candidate._id === "string" &&
        typeof candidate.organizationId === "string" &&
        typeof candidate.userId === "string" &&
        typeof candidate.role === "string"
    );
};

/**
 * Type guard for Better Auth invitation.
 */
export const isBetterAuthInvitation = (invitation: unknown): invitation is BetterAuthInvitation => {
    if (!invitation || typeof invitation !== "object") {
        return false;
    }

    const candidate = invitation as { _id?: unknown; email?: unknown; organizationId?: unknown; status?: unknown };

    return (
        typeof candidate._id === "string" &&
        typeof candidate.email === "string" &&
        typeof candidate.organizationId === "string" &&
        typeof candidate.status === "string" &&
        ["accepted", "canceled", "pending", "rejected"].includes(candidate.status as string)
    );
};
