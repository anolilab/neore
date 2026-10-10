import type { Doc, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../../_generated/server";

// `teamMember` IS a table in `lunora/schema.ts`, so the row type comes from the
// schema (`Doc<"teamMember">`) instead of a hand-written interface that could
// drift from it. `role` is a `v.union` of literals there, and optional: better-auth
// never writes it, so a row it inserted carries none and reads as a plain member.
type TeamMemberRole = NonNullable<Doc<"teamMember">["role"]>;
type OrgRole = "owner" | "admin" | "member";

/**
 * An organization role as it arrives from the caller: possibly unset, possibly a
 * role this file does not model.
 */
type OrgRoleInput = OrgRole | string | null | undefined;

/**
 * The `teamMember` row joining a user to a team, or `null` if they are not on it.
 *
 * Reads through the `teamId_userId` index, so this is a point lookup rather than a
 * scan — every other helper in this file is built on it.
 */
export const getTeamMember = async (context: QueryContext | MutationContext, teamId: string, userId: string): Promise<Doc<"teamMember"> | null> =>
    context.db.teamMember.findFirst({ where: { teamId, userId } });

/** Whether the user holds the `admin` role ON THIS TEAM. Organization role is not consulted. */
export const isTeamAdmin = async (context: QueryContext | MutationContext, teamId: string, userId: string): Promise<boolean> => {
    const teamMember = await getTeamMember(context, teamId, userId);

    return teamMember?.role === "admin";
};

/** Whether the user is on the team at all, in any role. */
export const isTeamMember = async (context: QueryContext | MutationContext, teamId: string, userId: string): Promise<boolean> => {
    const teamMember = await getTeamMember(context, teamId, userId);

    return teamMember !== null;
};

/**
 * Organization owner/admin, or team admin.
 *
 * The rule both {@link canManageTeamMembers} and {@link canEditTeamSettings} apply
 * today. They stay separate exports so either can diverge without touching the
 * other's callers, but the predicate lives once so they cannot drift by accident.
 *
 * `orgRole` is checked first and short-circuits the database read.
 */
const hasTeamAdminAuthority = async (context: QueryContext | MutationContext, teamId: string, userId: string, orgRole?: OrgRoleInput): Promise<boolean> => {
    if (orgRole === "owner" || orgRole === "admin") {
        return true;
    }

    return isTeamAdmin(context, teamId, userId);
};

/** Whether the user may add, remove or re-role members of this team. */
export const canManageTeamMembers = async (context: QueryContext | MutationContext, teamId: string, userId: string, orgRole?: OrgRoleInput): Promise<boolean> =>
    hasTeamAdminAuthority(context, teamId, userId, orgRole);

/**
 * Whether the user may invite others to this team.
 *
 * Deliberately weaker than {@link canManageTeamMembers}: any member can invite,
 * because an invitation still needs the invitee to accept.
 */
export const canInviteToTeam = async (context: QueryContext | MutationContext, teamId: string, userId: string): Promise<boolean> =>
    isTeamMember(context, teamId, userId);

/** Whether the user may change the team's name, description and other settings. */
export const canEditTeamSettings = async (context: QueryContext | MutationContext, teamId: string, userId: string, orgRole?: OrgRoleInput): Promise<boolean> =>
    hasTeamAdminAuthority(context, teamId, userId, orgRole);

/** The user's role on this team, or `null` if they are not a member. */
export const getTeamMemberRole = async (context: QueryContext | MutationContext, teamId: string, userId: string): Promise<TeamMemberRole | null> => {
    const teamMember = await getTeamMember(context, teamId, userId);

    if (!teamMember) {
        return null;
    }

    return teamMember.role ?? "member";
};
