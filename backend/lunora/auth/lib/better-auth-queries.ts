import type { Doc, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";
import { withoutUndefined } from "../../lib/patch";

// Better Auth's tables (organization, member, invitation, user) ARE part of the
// Lunora schema, so these wrappers are plain typed reads — they exist to keep the
// index names and id-branding in one place, not to escape the type system.

type AuthContext = MutationContext | QueryContext;

/**
 * Typed wrapper for querying Better Auth organization table.
 */
export const getOrganization = async (context: AuthContext, organizationId: string): Promise<Doc<"organization"> | null> =>
    context.db.organization.findFirst({ where: { _id: context.db.asId("organization", organizationId) } });

/**
 * Typed wrapper for querying Better Auth organization by slug.
 */
export const getOrganizationBySlug = async (context: AuthContext, slug: string): Promise<Doc<"organization"> | null> =>
    context.db.organization.findFirst({ where: { slug } });

/**
 * Typed wrapper for querying Better Auth members.
 */
export const getMembersByOrganization = async (context: AuthContext, organizationId: string, limit?: number): Promise<Doc<"member">[]> =>
    await context.db.member.findMany({ limit, where: { organizationId } }).then((result) => result.page);

/**
 * Typed wrapper for querying Better Auth member by organization and user.
 */
export const getMemberByOrganizationAndUser = async (context: AuthContext, organizationId: string, userId: string): Promise<Doc<"member"> | null> =>
    context.db.member.findFirst({ where: { organizationId, userId } });

/**
 * Typed wrapper for querying Better Auth members by userId.
 */
export const getMembersByUserId = async (context: AuthContext, userId: string): Promise<Doc<"member">[]> =>
    await context.db.member.findMany({ where: { userId } }).then((result) => result.page);

/**
 * Typed wrapper for querying Better Auth members by role.
 */
export const getMembersByOrganizationAndRole = async (context: AuthContext, organizationId: string, role: string, limit?: number): Promise<Doc<"member">[]> =>
    await context.db.member.findMany({ limit, where: { organizationId, role } }).then((result) => result.page);

/**
 * Typed wrapper for querying Better Auth invitation.
 */
export const getInvitation = async (context: AuthContext, invitationId: string): Promise<Doc<"invitation"> | null> =>
    context.db.invitation.findFirst({ where: { _id: context.db.asId("invitation", invitationId) } });

/**
 * Typed wrapper for querying Better Auth invitations by organization and status.
 */
export const getInvitationsByOrganizationAndStatus = async (
    context: AuthContext,
    organizationId: string,
    status: "pending" | "accepted" | "rejected" | "canceled",
    limit?: number,
): Promise<Doc<"invitation">[]> => await context.db.invitation.findMany({ limit, where: { organizationId, status } }).then((result) => result.page);

/**
 * Typed wrapper for querying Better Auth invitations by email, organization, and status.
 */
export const getInvitationsByEmailOrganizationAndStatus = async (
    context: AuthContext,
    email: string,
    organizationId: string,
    status: "pending" | "accepted" | "rejected" | "canceled",
    limit?: number,
): Promise<Doc<"invitation">[]> => await context.db.invitation.findMany({ limit, where: { email, organizationId, status } }).then((result) => result.page);

/**
 * Typed wrapper for querying Better Auth user.
 *
 * The `username` intersection is NOT a schema field: the `user` table has no
 * `username` column and no better-auth username plugin is configured (see
 * `lunora/auth.ts`), so it is always `undefined` at runtime. It is kept in the
 * type only because `organization.ts` still reads `inviter.username` — that read
 * is dead and should be deleted, at which point this intersection goes with it.
 */
export const getUser = async (context: AuthContext, userId: string): Promise<(Doc<"user"> & { username?: string | null }) | null> =>
    context.db.user.findFirst({ where: { _id: context.db.asId("user", userId) } });

/**
 * Typed wrapper for patching Better Auth organization.
 */
export const patchOrganization = async (context: MutationContext, organizationId: string, updates: Partial<Doc<"organization">>): Promise<void> => {
    await context.db.patch(context.db.asId("organization", organizationId), withoutUndefined(updates));
};

/**
 * Typed wrapper for patching Better Auth member.
 */
export const patchMember = async (context: MutationContext, memberId: string, updates: Partial<Doc<"member">>): Promise<void> => {
    await context.db.patch(context.db.asId("member", memberId), withoutUndefined(updates));
};

/**
 * Typed wrapper for patching Better Auth invitation.
 */
export const patchInvitation = async (context: MutationContext, invitationId: string, updates: Partial<Doc<"invitation">>): Promise<void> => {
    await context.db.patch(context.db.asId("invitation", invitationId), withoutUndefined(updates));
};
