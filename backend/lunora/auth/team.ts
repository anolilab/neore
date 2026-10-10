import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { DEFAULT_LIST_LIMIT } from "../lib/constants";
import { asyncMap } from "../lib/collections";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { getUser } from "./lib/better-auth-queries";
import { canEditTeamSettings, canManageTeamMembers } from "./lib/team-helpers";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";

/**
 * Team timestamps as epoch milliseconds. Our own writes store `Date.now()`, but
 * the default team better-auth creates with an organization stores an ISO
 * string — and the outputs declare a number, so returning that raw failed
 * `listTeams` for every organization with a default team.
 */
const toEpochMs = (value: unknown): number => {
    if (typeof value === "number") {
        return value;
    }

    const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));

    return Number.isNaN(parsed) ? 0 : parsed;
};

/** The optional `updatedAt` twin of {@link toEpochMs}: absent stays absent. */
const toOptionalEpochMs = (value: unknown): number | null | undefined => (value === undefined || value === null ? value : toEpochMs(value));

const MAXIMUM_TEAMS = 10;

/**
 * Check if user has permission for team management (owner or admin).
 */
const requireTeamManagePermission = (userRole: string | undefined) => {
    if (userRole !== "owner" && userRole !== "admin") {
        throw new LunoraError("FORBIDDEN", "Only organization owners can manage teams");
    }
};

/**
 * Adding or removing team members is an org owner/admin or TEAM admin action —
 * the same rule `updateTeamMemberRole` applies. It used to accept org role
 * `"member"`, so any plain member could add or remove anyone, team admins
 * included. Leaving a team is `leaveTeam`.
 */
const requireTeamMemberManager = async (
    context: Parameters<typeof canManageTeamMembers>[0] & { user: { activeOrganization?: { role: string } | null; userId: string } },
    teamId: string,
) => {
    if (!(await canManageTeamMembers(context, teamId, context.user.userId, context.user.activeOrganization?.role))) {
        throw new LunoraError("FORBIDDEN", "You do not have permission to manage team members");
    }
};

/**
 * Re-derive `team.memberCount` from the rows.
 *
 * better-auth 1.7.3 reserves team seats against that counter, and these
 * mutations write `teamMember` directly rather than through its adapter, so they
 * must keep it true. Recounting rather than incrementing keeps a lost race from
 * compounding. better-auth's own sync only ever RAISES the counter, so a removal
 * here that left it high would never be corrected.
 */
const syncTeamMemberCount = async (context: MutationCtx, teamId: string): Promise<void> => {
    const { page: members } = await context.db.teamMember.findMany({ where: { teamId } });

    await context.db.patch(context.db.asId("team", teamId), { memberCount: members.length });
};

// Create a new team in the active organization
export const createTeam = authMutation
    .use(rateLimit("team/create"))
    .input({
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        requireTeamManagePermission(context.user.activeOrganization?.role);

        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            throw new LunoraError("UNAUTHORIZED", "No active organization");
        }

        // Check team limit
        const { page: existingTeams } = await context.db.team.findMany({ limit: MAXIMUM_TEAMS + 1, where: { organizationId: orgId } });

        if (existingTeams.length >= MAXIMUM_TEAMS) {
            throw new LunoraError("BAD_REQUEST", `Team limit reached. Maximum ${MAXIMUM_TEAMS} teams allowed per organization.`);
        }

        // Create the team
        const teamId = await context.db.insert("team", {
            createdAt: context.now,
            memberCount: 0,
            name: args.name,
            organizationId: orgId,
        });

        context.log.event("team.create", { organizationId: orgId, teamId });

        return teamId;
    });

// List all teams in the active organization
const vListTeamsOutput = v.array(
    v.object({ createdAt: v.number(), id: v.string(), memberCount: v.number(), name: v.string(), updatedAt: v.optional(v.union(v.number(), v.null())) }),
);

export const listTeams = authQuery.output(v.from(vListTeamsOutput)).query(async ({ ctx: context }): Promise<Infer<typeof vListTeamsOutput>> => {
    const orgId = context.user.activeOrganization?.id;

    if (!orgId) {
        return [];
    }

    const { page: teams } = await context.db.team.findMany({ limit: DEFAULT_LIST_LIMIT, where: { organizationId: orgId } });

    return asyncMap(teams, async (team) => {
        const { page: members } = await context.db.teamMember.findMany({ limit: DEFAULT_LIST_LIMIT, where: { teamId: team._id } });

        return {
            createdAt: toEpochMs(team.createdAt),
            id: team._id,
            memberCount: members.length,
            name: team.name,
            updatedAt: toOptionalEpochMs(team.updatedAt),
        };
    });
});

// Get a specific team by ID
const vGetTeamOutput = v.union(
    v.object({ createdAt: v.number(), id: v.string(), memberCount: v.number(), name: v.string(), updatedAt: v.optional(v.union(v.number(), v.null())) }),
    v.null(),
);

export const getTeam = authQuery
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(vGetTeamOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vGetTeamOutput>> => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            return null;
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            return null;
        }

        const { page: members } = await context.db.teamMember.findMany({ limit: DEFAULT_LIST_LIMIT, where: { teamId: args.teamId } });

        return {
            createdAt: toEpochMs(team.createdAt),
            id: team._id,
            memberCount: members.length,
            name: team.name,
            updatedAt: toOptionalEpochMs(team.updatedAt),
        };
    });

// Update team details
export const updateTeam = authMutation
    .use(rateLimit("team/update"))
    .input({
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        requireTeamManagePermission(context.user.activeOrganization?.role);

        const teamId = context.db.asId("team", args.teamId);
        const team = await context.db.team.findFirst({ where: { _id: teamId } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        await context.db.patch(teamId, {
            ...(args.name && { name: args.name }),
            updatedAt: context.now,
        });

        context.log.event("team.update", { teamId: args.teamId, updatedName: Boolean(args.name) });
    });

// Delete a team
export const deleteTeam = authMutation
    .use(rateLimit("team/delete"))
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        requireTeamManagePermission(context.user.activeOrganization?.role);

        const teamId = context.db.asId("team", args.teamId);
        const team = await context.db.team.findFirst({ where: { _id: teamId } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        // Delete all team members first. Unbounded deliberately: a capped read
        // would orphan rows pointing at a team that no longer exists.
        const { page: members } = await context.db.teamMember.findMany({ where: { teamId: args.teamId } });

        for (const member of members) {
            await context.db.delete(member._id);
        }

        // Delete the team
        await context.db.delete(teamId);

        context.log.event("team.delete", { removedMemberCount: members.length, teamId: args.teamId });
    });

// Add a member to a team
export const addTeamMember = authMutation
    .use(rateLimit("team/addMember"))
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        await requireTeamMemberManager(context, args.teamId);

        // Check if user exists and is a member of the organization
        const user = await getUser(context, args.userId);

        if (!user) {
            throw new LunoraError("NOT_FOUND", "User not found");
        }

        const orgMembership = await context.db.member.findFirst({ where: { organizationId: context.user.activeOrganization?.id, userId: args.userId } });

        if (!orgMembership) {
            throw new LunoraError("FORBIDDEN", "User is not a member of this organization");
        }

        // Check if user is already a team member
        const existingMember = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: args.userId } });

        if (existingMember) {
            throw new LunoraError("BAD_REQUEST", "User is already a member of this team");
        }

        // Add team member with default "member" role
        await context.db.insert("teamMember", {
            createdAt: context.now,
            role: "member",
            teamId: args.teamId,
            userId: args.userId,
        });

        await syncTeamMemberCount(context, args.teamId);

        context.log.event("team.add_member", { teamId: args.teamId });
    });

// Remove a member from a team
export const removeTeamMember = authMutation
    .use(rateLimit("team/removeMember"))
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        await requireTeamMemberManager(context, args.teamId);

        // Find the team member
        const teamMember = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: args.userId } });

        if (!teamMember) {
            throw new LunoraError("NOT_FOUND", "User is not a member of this team");
        }

        // Remove team member
        await context.db.delete(teamMember._id);

        await syncTeamMemberCount(context, args.teamId);

        context.log.event("team.remove_member", { teamId: args.teamId });
    });

// List members of a team
const vListTeamMembersOutput = v.array(
    v.object({
        createdAt: v.optional(v.union(v.number(), v.null())),
        id: v.string(),
        role: v.union(v.literal("admin"), v.literal("member")),
        user: v.object({ email: v.string(), id: v.string(), image: v.optional(v.union(v.string(), v.null())), name: v.union(v.string(), v.null()) }),
        userId: v.string(),
    }),
);

export const listTeamMembers = authQuery
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(vListTeamMembersOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vListTeamMembersOutput>> => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            return [];
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            return [];
        }

        const { page: teamMembers } = await context.db.teamMember.findMany({ limit: DEFAULT_LIST_LIMIT, where: { teamId: args.teamId } });

        const enrichedMembers = await asyncMap(teamMembers, async (teamMember) => {
            const user = await getUser(context, teamMember.userId);

            if (!user) {
                return null;
            }

            return {
                createdAt: toOptionalEpochMs(teamMember.createdAt),
                id: teamMember._id,
                role: teamMember.role ?? "member",
                user: {
                    email: user.email,
                    id: user._id,
                    image: user.image,
                    name: user.name,
                },
                userId: teamMember.userId,
            };
        });

        return enrichedMembers.filter((m): m is NonNullable<typeof m> => m !== null);
    });

// Set the active team for the current session
export const setActiveTeam = authMutation
    .use(rateLimit("team/setActive"))
    .input({
        teamId: v.union(v.string().max(MAX_LENGTH.id), v.null()),
    })
    .mutation(async ({ args, ctx: context }) => {
        if (args.teamId) {
            const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

            if (!team) {
                throw new LunoraError("NOT_FOUND", "Team not found");
            }

            // Verify team belongs to active organization
            if (team.organizationId !== context.user.activeOrganization?.id) {
                throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
            }

            // Verify user is a member of the team
            const teamMembership = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: context.user.userId } });

            if (!teamMembership) {
                throw new LunoraError("FORBIDDEN", "You are not a member of this team");
            }
        }

        // Update session with activeTeamId
        // Find the current session
        const { page: sessions } = await context.db.session.findMany({ limit: 10, where: { userId: context.user.userId } });

        // Update the most recent valid session
        for (const session of sessions) {
            if (session.expiresAt > context.now) {
                // `session.activeTeamId` is `v.optional(v.string())` — clearing it is
                // `undefined` (field removed), not `null` (which the validator rejects).
                await patchRow(context.db, session, {
                    activeTeamId: args.teamId ?? undefined,
                });
                break;
            }
        }

        context.log.event("team.set_active", { hasTeam: args.teamId !== undefined && args.teamId !== null });
    });

// Leave a team (self-remove)
export const leaveTeam = authMutation
    .use(rateLimit("team/leave"))
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        // Find the team member
        const teamMember = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: context.user.userId } });

        if (!teamMember) {
            throw new LunoraError("NOT_FOUND", "You are not a member of this team");
        }

        // Remove team member
        await context.db.delete(teamMember._id);

        await syncTeamMemberCount(context, args.teamId);

        context.log.event("team.leave", { teamId: args.teamId });
    });

// Update team member role
export const updateTeamMemberRole = authMutation
    .use(rateLimit("team/updateRole"))
    .input({
        role: v.union(v.literal("admin"), v.literal("member")),
        teamId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        // Check if user can manage team members
        const canManage = await canManageTeamMembers(context, args.teamId, context.user.userId, context.user.activeOrganization?.role);

        if (!canManage) {
            throw new LunoraError("FORBIDDEN", "You do not have permission to change team member roles");
        }

        // Find the team member
        const teamMember = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: args.userId } });

        if (!teamMember) {
            throw new LunoraError("NOT_FOUND", "User is not a member of this team");
        }

        // Update the role
        await context.db.patch(teamMember._id, {
            role: args.role,
        });

        context.log.event("team.update_member_role", { role: args.role, teamId: args.teamId });
    });

// Get team settings
const vGetTeamSettingsOutput = v.union(
    v.object({
        allowedModels: v.union(v.array(v.string()), v.null()),
        inheritedModels: v.union(v.array(v.string()), v.null()),
        isInheriting: v.boolean(),
        teamId: v.string(),
    }),
    v.null(),
);

export const getTeamSettings = authQuery
    .input({
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(vGetTeamSettingsOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vGetTeamSettingsOutput>> => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            return null;
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            return null;
        }

        // Verify user is a member of the team or org admin/owner
        const orgRole = context.user.activeOrganization?.role;
        const teamMembership = await context.db.teamMember.findFirst({ where: { teamId: args.teamId, userId: context.user.userId } });

        if (!teamMembership && orgRole !== "owner" && orgRole !== "admin") {
            return null;
        }

        // Get team settings
        const settings = await context.db.teamSettings.findFirst({ where: { teamId: args.teamId } });

        // Get organization settings for inheritance info
        const org = await context.db.organization.findFirst({ where: { _id: context.db.asId("organization", team.organizationId) } });
        const orgAllowedModels = org?.allowedModels ?? null;

        return {
            allowedModels: settings?.allowedModels ?? null,
            inheritedModels: orgAllowedModels,
            isInheriting: !settings?.allowedModels,
            teamId: args.teamId,
        };
    });

// Update team settings
export const updateTeamSettings = authMutation
    .use(rateLimit("team/updateSettings"))
    .input({
        allowedModels: v.union(v.array(v.string().max(MAX_LENGTH.short)), v.null()),
        teamId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", args.teamId) } });

        if (!team) {
            throw new LunoraError("NOT_FOUND", "Team not found");
        }

        // Verify team belongs to active organization
        if (team.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("FORBIDDEN", "Team does not belong to your organization");
        }

        // Check if user can edit team settings
        const canEdit = await canEditTeamSettings(context, args.teamId, context.user.userId, context.user.activeOrganization?.role);

        if (!canEdit) {
            throw new LunoraError("FORBIDDEN", "You do not have permission to edit team settings");
        }

        // Get existing settings
        const existingSettings = await context.db.teamSettings.findFirst({ where: { teamId: args.teamId } });

        if (existingSettings) {
            // Update existing settings
            if (args.allowedModels === null) {
                // Reset to inherit from organization
                await patchRow(context.db, existingSettings, {
                    allowedModels: undefined,
                });
            } else {
                await context.db.patch(existingSettings._id, {
                    allowedModels: args.allowedModels,
                });
            }
        } else if (args.allowedModels !== null) {
            // Create new settings only if not inheriting
            await context.db.insert("teamSettings", {
                allowedModels: args.allowedModels,
                organizationId: team.organizationId,
                teamId: args.teamId,
            });
        }

        context.log.event("team.update_settings", { clearedModels: args.allowedModels === null, teamId: args.teamId });
    });

// Get user's teams (teams the current user is a member of)
const vGetMyTeamsOutput = v.array(
    v.object({ createdAt: v.number(), id: v.string(), name: v.string(), role: v.union(v.literal("admin"), v.literal("member")) }),
);

export const getMyTeams = authQuery.output(v.from(vGetMyTeamsOutput)).query(async ({ ctx: context }): Promise<Infer<typeof vGetMyTeamsOutput>> => {
    const orgId = context.user.activeOrganization?.id;

    if (!orgId) {
        return [];
    }

    // Get all team memberships for this user
    const { page: memberships } = await context.db.teamMember.findMany({ limit: DEFAULT_LIST_LIMIT, where: { userId: context.user.userId } });

    // Filter to teams in the current organization and enrich with team data
    const teamsInOrg = await asyncMap(memberships, async (membership) => {
        const team = await context.db.team.findFirst({ where: { _id: context.db.asId("team", membership.teamId) } });

        if (!team || team.organizationId !== orgId) {
            return null;
        }

        return {
            createdAt: toEpochMs(team.createdAt),
            id: team._id,
            name: team.name,
            role: membership.role ?? "member",
        };
    });

    return teamsInOrg.filter((t): t is NonNullable<typeof t> => t !== null);
});
