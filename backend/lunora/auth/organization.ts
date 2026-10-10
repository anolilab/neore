import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { getAuth } from "../auth";
import { DEFAULT_LIST_LIMIT, DEFAULT_PLAN, MEMBER_LIMIT } from "../lib/constants";
import { asyncMap } from "../lib/collections";
import type { AuthMutationCtx as AuthMutationContext } from "../lib/crpc";
// `rateLimit` is a middleware factory;
// it is called, so it must be a VALUE import (23 TS1361/TS1360s when it wasn't).
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { listUserOrganizations } from "./functions";
import {
    getInvitation,
    getInvitationsByEmailOrganizationAndStatus,
    getInvitationsByOrganizationAndStatus,
    getMemberByOrganizationAndUser,
    getMembersByOrganization,
    getMembersByOrganizationAndRole,
    // Aliased: this module exports its own `getOrganization` cRPC query below.
    getOrganization as getOrganizationById,
    getOrganizationBySlug,
    getUser,
    patchInvitation,
    patchMember,
    patchOrganization,
} from "./lib/better-auth-queries";
import { isOrganizationOwner, isOrganizationOwner as isOwner, validateOrganizationAccess } from "./lib/organization-helpers";
import { MAX_LENGTH } from "../lib/validators";

/**
 * Type for the Better Auth organization plugin API methods.
 * These methods are added at runtime by the organization plugin but aren't
 * fully typed in the base betterAuth return type.
 */
interface OrganizationApi {
    acceptInvitation: (args: { body: { invitationId: string }; headers: Headers }) => Promise<void>;
    cancelInvitation: (args: { body: { invitationId: string }; headers: Headers }) => Promise<void>;
    createInvitation: (args: { body: { email: string; organizationId: string; role: string }; headers: Headers }) => Promise<{ id: string }>;
    createOrganization: (args: { body: { monthlyCredits: number; name: string; slug: string }; headers: Headers }) => Promise<{ id: string; slug: string }>;
    deleteOrganization: (args: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
    hasPermission: (args: { body: { permissions: Record<string, string[]> }; headers: Headers }) => Promise<{ success: boolean }>;
    leaveOrganization: (args: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
    rejectInvitation: (args: { body: { invitationId: string }; headers: Headers }) => Promise<void>;
    removeMember: (args: { body: { memberIdOrEmail: string; organizationId: string | undefined }; headers: Headers }) => Promise<void>;
    setActiveOrganization: (args: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
}

/**
 * Helper to get better-auth API instance for making authenticated API calls.
 * Creates the auth instance and provides methods to call the API with proper headers.
 */
const getBetterAuthApi = (_context: AuthMutationContext) => {
    const auth = getAuth();
    // Cast to include organization plugin methods which exist at runtime
    const api = auth.api as unknown as OrganizationApi;
    // Create headers with the user's session token for authentication
    // Better Auth uses these headers to identify the user making the request
    const headers = new Headers();

    return {
        acceptInvitation: (body: { invitationId: string }) => api.acceptInvitation({ body, headers }),
        cancelInvitation: (body: { invitationId: string }) => api.cancelInvitation({ body, headers }),
        createInvitation: (body: { email: string; organizationId: string; role: string }) => api.createInvitation({ body, headers }),
        createOrganization: (body: { monthlyCredits: number; name: string; slug: string }) => api.createOrganization({ body, headers }),
        deleteOrganization: (body: { organizationId: string }) => api.deleteOrganization({ body, headers }),
        hasPermission: async (body: { permissions: Record<string, string[]> }) => {
            const result = await api.hasPermission({ body, headers });

            return result;
        },
        leaveOrganization: (body: { organizationId: string }) => api.leaveOrganization({ body, headers }),
        rejectInvitation: (body: { invitationId: string }) => api.rejectInvitation({ body, headers }),
        removeMember: (body: { memberIdOrEmail: string; organizationId: string | undefined }) => api.removeMember({ body, headers }),
        setActiveOrganization: (body: { organizationId: string }) => api.setActiveOrganization({ body, headers }),
    };
};

/**
 * Check if user has permission for a given action using Better Auth API.
 */
const hasPermission = async (context: AuthMutationContext, body: { permissions: Record<string, string[]> }, shouldThrow = true): Promise<boolean> => {
    const api = getBetterAuthApi(context);
    const result = await api.hasPermission(body);

    if (shouldThrow && !result.success) {
        throw new LunoraError("FORBIDDEN", "Insufficient permissions for this action");
    }

    return result.success;
};

// Check if organization slug is available
export const checkSlug = authQuery
    .input({
        slug: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ available: v.boolean() }))
    .query(async ({ args, ctx: context }) => {
        const existingOrg = await getOrganizationBySlug(context, args.slug);

        return { available: !existingOrg };
    });

// Get current user's membership in the active organization
export const getActiveMember = authQuery
    .input({})
    .output(v.union(v.object({ createdAt: v.number(), id: v.string(), role: v.string() }), v.null()))
    .query(async ({ ctx: context }) => {
        const activeOrgId = context.user.activeOrganization?.id;

        if (!activeOrgId) {
            return null;
        }

        const member = await context.db.member.findFirst({ where: { organizationId: activeOrgId, userId: context.user.userId } });

        if (!member) {
            return null;
        }

        return {
            createdAt: member.createdAt,
            id: member._id,
            role: member.role,
        };
    });

// List all invitations for the current user's email address
const vListUserInvitationsOutput = v.array(
    v.object({
        expiresAt: v.number(),
        id: v.string(),
        inviterName: v.union(v.string(), v.null()),
        organizationName: v.string(),
        organizationSlug: v.string(),
        role: v.string(),
    }),
);

export const listUserInvitations = authQuery
    .input({})
    .output(v.from(vListUserInvitationsOutput))
    .query(async ({ ctx: context }): Promise<Infer<typeof vListUserInvitationsOutput>> => {
        const { page: invitations } = await context.db.invitation.findMany({
            limit: DEFAULT_LIST_LIMIT,
            where: { email: context.user.email, status: "pending" },
        });

        const enrichedInvitations = await asyncMap(invitations, async (invitation) => {
            const org = await getOrganizationById(context, invitation.organizationId);
            const inviter = await getUser(context, invitation.inviterId);

            if (!org) {
                return null;
            }

            return {
                expiresAt: invitation.expiresAt,
                id: invitation._id,
                inviterName: inviter?.name || null,
                organizationName: org.name,
                organizationSlug: org.slug ?? "",
                role: invitation.role || "member",
            };
        });

        return enrichedInvitations.filter((inv): inv is NonNullable<typeof inv> => inv !== null);
    });

// Add member directly (without invitation) - for admin/owner use
// List all organizations for current user (excluding active organization)
const vListOrganizationsOutput = v.object({
    canCreateOrganization: v.boolean(),
    organizations: v.array(
        v.object({
            createdAt: v.number(),
            id: v.string(),
            isOwner: v.boolean(),
            logo: v.optional(v.union(v.string(), v.null())),
            name: v.string(),
            plan: v.string(),
            slug: v.string(),
        }),
    ),
});

export const listOrganizations = authQuery
    .input({})
    .output(v.from(vListOrganizationsOutput))
    .query(async ({ ctx: context }): Promise<Infer<typeof vListOrganizationsOutput>> => {
        // Get all organizations for user using helper
        const orgs = await listUserOrganizations(context, context.user.userId);

        if (!orgs || orgs.length === 0) {
            return {
                canCreateOrganization: true, // No orgs, can create first one
                organizations: [],
            };
        }

        const activeOrgId = context.user.activeOrganization?.id;

        // Calculate if user can create organization
        const canCreateOrganization = true;

        // Filter out active organization from the list to return (but keep all orgs for permission check above)
        const filteredOrgs = orgs.filter((org) => org._id !== activeOrgId);

        // Optimized: Check ownership in parallel, pass pre-fetched org to avoid redundant queries
        const enrichedOrgs = await asyncMap(filteredOrgs, async (org) => {
            // Pass org data to isOrganizationOwner to avoid re-fetching
            const userIsOwner = await isOrganizationOwner(context, org._id, org);

            return {
                createdAt: org._creationTime,
                id: org._id,
                isOwner: userIsOwner,
                logo: org.logo || null,
                name: org.name,
                plan: DEFAULT_PLAN,
                slug: org.slug || "",
            };
        });

        return {
            canCreateOrganization,
            organizations: enrichedOrgs,
        };
    });

// Create a new organization (max 1 without subscription)
export const createOrganization = authMutation
    .use(rateLimit("organization/create"))
    .input({
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ id: v.string(), slug: v.string() }))
    .mutation(async ({ args, ctx: context }) => {
        // Generate unique slug
        let slug = args.name;
        let attempt = 0;

        while (attempt < 10) {
            // Check if slug is already taken
            const existingOrg = await getOrganizationBySlug(context, slug);

            if (!existingOrg) {
                break; // Slug is available!
            }

            // Add random suffix for uniqueness. `crypto` rather than
            // `Math.random()`: a slug is not a secret, but this is the auth
            // module and the stronger source costs nothing.
            slug += `-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
            attempt += 1;
        }

        if (attempt >= 10) {
            throw new LunoraError("BAD_REQUEST", "Could not generate a unique slug. Please provide a custom slug.");
        }

        // Create organization via Better Auth
        const api = getBetterAuthApi(context);
        const org = await api.createOrganization({
            monthlyCredits: 0,
            name: args.name,
            slug,
        });

        if (!org) {
            throw new LunoraError("INTERNAL_SERVER_ERROR", "Failed to create organization");
        }

        // Set the ownerId on the organization (the creator is automatically the owner via Better Auth)
        // Better Auth creates a member with role='owner', but we also store ownerId directly on org
        await patchOrganization(context, org.id, {
            ownerId: context.user.userId,
        });

        // Set as active organization
        await setActiveOrganizationHandler(context, {
            organizationId: org.id,
        });

        context.log.event("organization.create", { organizationId: org.id });

        return {
            id: org.id,
            slug: org.slug,
        };
    });

// Update organization details
export const updateOrganization = authMutation
    .use(rateLimit("organization/update"))
    .input({
        logo: v.optional(v.string().max(MAX_LENGTH.document)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        slug: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .mutation(async ({ args, ctx: context }) => {
        const activeOrgId = context.user.activeOrganization?.id;

        if (!activeOrgId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        // Validate organization access and permissions
        await validateOrganizationAccess(context, activeOrgId);
        await hasPermission(context, { permissions: { organization: ["update"] } });

        let { slug } = args;

        // If slug is provided, validate it
        if (args.slug) {
            // Check if user is owner - owners can change slug
            const userIsOwner = await isOwner(context, activeOrgId);

            if (userIsOwner) {
                slugSchema.parse(args.slug);
            } else {
                // Non-owners can't change slug
                slug = undefined;
            }

            if (slug) {
                // Check if slug is taken
                const existingOrg = await getOrganizationBySlug(context, slug);

                if (existingOrg && existingOrg._id !== activeOrgId) {
                    throw new LunoraError("BAD_REQUEST", "This slug is already taken");
                }
            }
        }

        await patchOrganization(context, activeOrgId, {
            logo: args.logo,
            name: args.name,
            ...(slug && { slug }),
        });

        context.log.event("organization.update", { organizationId: activeOrgId, updatedSlug: Boolean(slug) });
    });

const SLUG_RE = /^[a-z0-9-]+$/;

/** Was `z.string().min(3).max(50).regex(…)`; `.parse` throws on failure either way. */
const slugSchema = v.string().check((slug) => slug.length >= 3 && slug.length <= 50 && SLUG_RE.test(slug), {
    message: "slug must be 3-50 characters of lowercase letters, digits or hyphens",
    schema: { maxLength: 50, minLength: 3, pattern: "^[a-z0-9-]+$" },
});

const setActiveOrganizationHandler = async (context: AuthMutationContext, args: { organizationId: string }) => {
    const api = getBetterAuthApi(context);

    await api.setActiveOrganization({ organizationId: args.organizationId });

    // Skip updating lastActiveOrganizationId to avoid aggregate issues
    // The active organization is already tracked in the session

    return null;
};

// Set active organization
export const setActiveOrganization = authMutation
    .use(rateLimit("organization/setActive"))
    .input({
        organizationId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        await setActiveOrganizationHandler(context, args);

        context.log.event("organization.set_active", { organizationId: args.organizationId });
    });

// Accept invitation
export const acceptInvitation = authMutation
    .use(rateLimit("organization/accept"))
    .input({
        invitationId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Validate that the invitation is for the current user's email (optimized)
        const invitation = await getInvitation(context, args.invitationId);

        // Additional validation that it's for the current user
        if (invitation && invitation.email !== context.user.email) {
            throw new LunoraError("FORBIDDEN", "This invitation is not found for your email address");
        }

        if (!invitation) {
            throw new LunoraError("FORBIDDEN", "This invitation is not found for your email address");
        }

        if (invitation.status !== "pending") {
            throw new LunoraError("BAD_REQUEST", "This invitation has already been processed");
        }

        const api = getBetterAuthApi(context);

        await api.acceptInvitation({ invitationId: args.invitationId });

        context.log.event("organization.accept_invitation", { invitationId: args.invitationId });
    });

// Reject invitation
export const rejectInvitation = authMutation
    .use(rateLimit("organization/rejectInvite"))
    .input({
        invitationId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Get the specific invitation directly
        const invitation = await getInvitation(context, args.invitationId);

        // Additional validation that it's for the current user
        if (invitation && invitation.email !== context.user.email) {
            throw new LunoraError("FORBIDDEN", "This invitation is not found for your email address");
        }

        if (!invitation) {
            throw new LunoraError("FORBIDDEN", "This invitation is not found for your email address");
        }

        if (invitation.status !== "pending") {
            throw new LunoraError("BAD_REQUEST", "This invitation has already been processed");
        }

        const api = getBetterAuthApi(context);

        await api.rejectInvitation({ invitationId: args.invitationId });

        context.log.event("organization.reject_invitation", { invitationId: args.invitationId });
    });

// Remove member from organization
export const removeMember = authMutation
    .use(rateLimit("organization/removeMember"))
    .input({
        memberId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Permission: member delete
        await hasPermission(context, { permissions: { member: ["delete"] } });

        const api = getBetterAuthApi(context);

        await api.removeMember({
            memberIdOrEmail: args.memberId,
            organizationId: context.user.activeOrganization?.id,
        });

        context.log.event("organization.remove_member", { memberId: args.memberId });
    });

// Leave organization (self-leave)
export const leaveOrganization = authMutation
    .use(rateLimit("organization/leave"))
    .input({})
    .mutation(async ({ ctx: context }) => {
        const organizationId = context.user.activeOrganization?.id;

        if (!organizationId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        // Check if user is owner
        const userIsOwner = await isOwner(context, organizationId);

        // Prevent the last owner from leaving the organization
        // (Organizations must have at least one owner)
        if (userIsOwner) {
            // Use the compound index to efficiently find owners
            const owners = await getMembersByOrganizationAndRole(
                context,
                organizationId,
                "owner",
                2, // We only need to know if there's more than one owner
            );

            if (owners.length <= 1) {
                throw new LunoraError("FORBIDDEN", "Cannot leave organization as the only owner. Transfer ownership or add another owner first.");
            }
        }

        const api = getBetterAuthApi(context);

        await api.leaveOrganization({ organizationId });

        context.log.event("organization.leave", { organizationId });

        // Automatically switch to another organization before leaving
        const userOrgs = await listUserOrganizations(context, context.user.userId);
        const alternativeOrg = userOrgs.find((org) => org._id !== organizationId);

        if (alternativeOrg) {
            await setActiveOrganizationHandler(context, {
                organizationId: alternativeOrg._id,
            });
        }
    });

// Update member role
export const updateMemberRole = authMutation
    .use(rateLimit("organization/updateRole"))
    .input({
        memberId: v.string().max(MAX_LENGTH.id),
        role: v.union(v.literal("owner"), v.literal("member")),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Permission: member update
        await hasPermission(context, { permissions: { member: ["update"] } });

        // `hasPermission` speaks for the ACTIVE org only, and `patchMember` writes
        // any row by id — so the member must be in the active org, and only an
        // owner may mint another owner (an admin holds `member:update` too).
        const member = await context.db.member.findFirst({ where: { _id: context.db.asId("member", args.memberId) } });

        if (!member || member.organizationId !== context.user.activeOrganization?.id) {
            throw new LunoraError("NOT_FOUND", "Member not found");
        }

        if (args.role === "owner" && context.user.activeOrganization?.role !== "owner") {
            throw new LunoraError("FORBIDDEN", "Only an owner can grant the owner role");
        }

        // Update member role directly
        await patchMember(context, args.memberId, { role: args.role });

        context.log.event("organization.update_member_role", { memberId: args.memberId, role: args.role });
    });

// Delete organization (owner only)
export const deleteOrganization = authMutation
    .use(rateLimit("organization/delete"))
    .input({})
    .mutation(async ({ ctx: context }) => {
        // Permission: organization delete
        await hasPermission(context, { permissions: { organization: ["delete"] } });

        const organizationId = context.user.activeOrganization?.id;

        if (!organizationId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        // Check if user is owner (only owners can delete)
        const userIsOwner = await isOwner(context, organizationId);

        if (!userIsOwner) {
            throw new LunoraError("FORBIDDEN", "Only organization owners can delete organizations.");
        }

        // Switch to another organization before deleting
        const userOrgs = await listUserOrganizations(context, context.user.userId);
        const alternativeOrg = userOrgs.find((org) => org._id !== organizationId);

        if (alternativeOrg) {
            await setActiveOrganizationHandler(context, {
                organizationId: alternativeOrg._id,
            });
        }

        // Delete organization via Better Auth
        const api = getBetterAuthApi(context);

        await api.deleteOrganization({ organizationId });

        context.log.event("organization.delete", { organizationId });
    });

// Get organization details by slug
const vGetOrganizationOutput = v.union(
    v.object({
        createdAt: v.number(),
        id: v.string(),
        isActive: v.boolean(),
        isOwner: v.boolean(),
        logo: v.optional(v.union(v.string(), v.null())),
        membersCount: v.number(),
        name: v.string(),
        plan: v.string(),
        role: v.optional(v.string()),
        slug: v.string(),
    }),
    v.null(),
);

export const getOrganization = authQuery
    .input({
        slug: v.string().max(MAX_LENGTH.short),
    })
    .output(v.from(vGetOrganizationOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vGetOrganizationOutput>> => {
        // Get organization by slug using index
        const org = await getOrganizationBySlug(context, args.slug);

        if (!org) {
            return null;
        }

        // Members only: a non-member gets the same answer as an unknown slug.
        // (An invitee reads the org through `getOrganizationOverview` with the
        // invitation id instead.) Looked up directly, not in the capped list below.
        const currentMember = await getMemberByOrganizationAndUser(context, org._id, context.user.userId);

        if (!currentMember) {
            return null;
        }

        // Get all members for this organization
        const members = await getMembersByOrganization(context, org._id, DEFAULT_LIST_LIMIT);

        // Check if user is owner (pass pre-fetched org to avoid redundant DB query)
        const userIsOwner = await isOwner(context, org._id, org);

        const plan = DEFAULT_PLAN;

        return {
            createdAt: org.createdAt,
            id: org._id,
            isActive: org._id === context.user.activeOrganization?.id,
            isOwner: userIsOwner,
            logo: org.logo || null,
            membersCount: members.length || 1,
            name: org.name,
            plan,
            role: currentMember?.role,
            slug: org.slug || "",
        };
    });

// Get organization overview with optional invitation details
const vGetOrganizationOverviewOutput = v.union(
    v.object({
        createdAt: v.number(),
        id: v.string(),
        invitation: v.union(
            v.object({
                email: v.string(),
                expiresAt: v.number(),
                id: v.string(),
                inviterEmail: v.string(),
                inviterId: v.string(),
                inviterName: v.string(),
                inviterUsername: v.union(v.string(), v.null()),
                organizationId: v.string(),
                organizationName: v.string(),
                organizationSlug: v.string(),
                role: v.string(),
                status: v.string(),
            }),
            v.null(),
        ),
        isActive: v.boolean(),
        isOwner: v.boolean(),
        logo: v.optional(v.union(v.string(), v.null())),
        name: v.string(),
        plan: v.optional(v.string()),
        role: v.optional(v.string()),
        slug: v.string(),
    }),
    v.null(),
);

export const getOrganizationOverview = authQuery
    .input({
        inviteId: v.optional(v.string().max(MAX_LENGTH.id)),
        slug: v.string().max(MAX_LENGTH.short),
    })
    .output(v.from(vGetOrganizationOverviewOutput))
    .query(async ({ args, ctx: context }): Promise<Infer<typeof vGetOrganizationOverviewOutput>> => {
        // Get organization details
        const org = await getOrganizationBySlug(context, args.slug);

        if (!org) {
            return null;
        }

        // Check if user is owner (pass pre-fetched org to avoid redundant DB query)
        const userIsOwner = await isOwner(context, org._id, org);

        const organizationData = {
            createdAt: org.createdAt,
            id: org._id,
            isActive: context.user.activeOrganization?.id === org._id,
            isOwner: userIsOwner,
            logo: org.logo,
            name: org.name,
            plan: undefined,
            role: context.user.activeOrganization?.role,
            slug: org.slug || "",
        };

        // Handle invitation - either by ID or auto-find by user email
        const invitationData = await (async () => {
            const invitation = await (async () => {
                if (args.inviteId) {
                    // If inviteId is provided, fetch specific invitation
                    // `db.get(id)` takes ONE public argument. The two-argument form
                    // looked up a row whose `_id` is the literal string "invitation"
                    // and passed the real id as an internal table-name hint — so this
                    // could never find anything, and the `?? null` below always fired.
                    // Same bug lived in `betterAuthQueries.getInvitation`.
                    const inv = await context.db.invitation.findFirst({ where: { _id: context.db.asId("invitation", args.inviteId) } });

                    if (!inv || inv.organizationId !== org._id) {
                        return null;
                    }

                    return inv;
                }

                // If no inviteId, search for pending invitations for current user's email
                // Using the email_organizationId_status index for efficient lookup
                const invitations = await getInvitationsByEmailOrganizationAndStatus(context, context.user.email, org._id, "pending", 1);

                return invitations[0] || null;
            })();

            if (!invitation) {
                return null;
            }

            // Get inviter details (inviter must exist for invitation)
            const inviter = await getUser(context, invitation.inviterId);

            if (!inviter) {
                throw new LunoraError("NOT_FOUND", "Inviter not found");
            }

            // The `user` table has no `username` column and no better-auth username
            // plugin is configured, so this was always `null` at runtime. Kept as an
            // explicit `null` because the field is required by the output validator.
            const inviterUsername = null;

            return {
                email: invitation.email,
                expiresAt: invitation.expiresAt,
                id: invitation._id,
                inviterEmail: inviter.email,
                inviterId: invitation.inviterId,
                inviterName: inviter.name ?? "",
                inviterUsername,
                organizationId: invitation.organizationId,
                organizationName: org.name,
                organizationSlug: org.slug ?? "",
                role: invitation.role ?? "member",
                status: invitation.status,
            };
        })();

        return {
            ...organizationData,
            invitation: invitationData,
        };
    });

// List members by organization slug
export const listMembers = authQuery
    .input({
        slug: v.string().max(MAX_LENGTH.short),
    })
    .output(
        v.object({
            currentUserRole: v.optional(v.string()),
            isOwner: v.boolean(),
            members: v.array(
                v.object({
                    createdAt: v.number(),
                    id: v.string(),
                    organizationId: v.string(),
                    role: v.optional(v.string()),
                    user: v.object({
                        email: v.string(),
                        id: v.string(),
                        image: v.optional(v.union(v.string(), v.null())),
                        name: v.union(v.string(), v.null()),
                    }),
                    userId: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args, ctx: context }) => {
        const org = await getOrganizationBySlug(context, args.slug);

        if (!org) {
            return {
                isOwner: false,
                members: [],
            };
        }

        if (context.user.activeOrganization?.id !== org._id) {
            throw new LunoraError("FORBIDDEN", "You are not a member of this organization");
        }

        // Get members for this organization
        // Limited to prevent unbounded queries with large organizations
        const members = await getMembersByOrganization(context, org._id, DEFAULT_LIST_LIMIT);

        // Check if user is owner (pass pre-fetched org to avoid redundant DB query)
        const userIsOwner = await isOwner(context, org._id, org);

        if (!members || members.length === 0) {
            return {
                isOwner: userIsOwner,
                members: [],
            };
        }

        // Optimized: Enrich with user data using parallel fetching
        const enrichedMembers = await asyncMap(members, async (member) => {
            // Get user data for this member (parallel via asyncMap)
            const user = await getUser(context, member.userId);

            if (!user) {
                // Return null and filter out below instead of throwing
                return null;
            }

            return {
                createdAt: member.createdAt,
                id: member._id,
                organizationId: org._id,
                role: member.role,
                user: {
                    email: user.email,
                    id: user._id,
                    image: user.image,
                    name: user.name,
                },
                userId: member.userId,
            };
        });

        // Filter out null results (missing users)
        const validMembers = enrichedMembers.filter((m): m is NonNullable<typeof m> => m !== null);

        return {
            currentUserRole: context.user.activeOrganization?.role,
            isOwner: userIsOwner,
            members: validMembers,
        };
    });

// List pending invitations by organization slug
export const listPendingInvitations = authQuery
    .input({
        slug: v.string().max(MAX_LENGTH.short),
    })
    .output(
        v.array(
            v.object({
                createdAt: v.number(),
                email: v.string(),
                expiresAt: v.number(),
                id: v.string(),
                organizationId: v.string(),
                role: v.string(),
                status: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx: context }) => {
        // Get organization by slug using index
        const org = await getOrganizationBySlug(context, args.slug);

        if (!org) {
            return [];
        }

        // Check if user is a member of the active organization and it matches
        if (context.user.activeOrganization?.id !== org._id) {
            return [];
        }

        // Check if user has permission to manage invitations (owners can manage invites)
        const userIsOwner = await isOwner(context, org._id, org);

        if (!userIsOwner) {
            return [];
        }

        // Get pending invitations directly using the organizationId_status index
        // Limited to 100 to prevent unbounded queries with many invitations
        const pendingInvitations = await getInvitationsByOrganizationAndStatus(context, org._id, "pending", DEFAULT_LIST_LIMIT);

        const mappedInvitations = pendingInvitations.map((invitation) => {
            return {
                createdAt: invitation._creationTime,
                email: invitation.email,
                expiresAt: invitation.expiresAt,
                id: invitation._id,
                organizationId: invitation.organizationId,
                role: invitation.role || "member",
                status: invitation.status,
            };
        });

        return mappedInvitations;
    });

// Invite member to organization by slug
export const inviteMember = authMutation
    .use(rateLimit("organization/invite"))
    .input({
        email: v.string().max(MAX_LENGTH.short),
        role: v.union(v.literal("owner"), v.literal("member")),
    })
    .mutation(async ({ args, ctx: context }) => {
        // Premium guard for invitations
        // premiumGuard(ctx.user);

        // Permission: invitation create
        await hasPermission(context, { permissions: { invitation: ["create"] } });

        // An admin holds this permission too; only an owner may mint an owner.
        if (args.role === "owner" && context.user.activeOrganization?.role !== "owner") {
            throw new LunoraError("FORBIDDEN", "Only an owner can grant the owner role");
        }

        const orgId = context.user.activeOrganization?.id;

        if (!orgId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        // Check member count limit (5 members max per organization)
        // Get all members for this organization
        const members = await getMembersByOrganization(context, orgId, DEFAULT_LIST_LIMIT);

        // Check current member count (including pending invitations)
        const currentMemberCount = members.length;

        // Get pending invitations count
        // Count pending invitations to check against member limit
        const pendingInvitations = await getInvitationsByOrganizationAndStatus(context, orgId, "pending", DEFAULT_LIST_LIMIT);

        const pendingCount = pendingInvitations.length;
        const totalCount = currentMemberCount + pendingCount;

        // Check against limit (5 members)
        if (totalCount >= MEMBER_LIMIT) {
            throw new LunoraError(
                "TOO_MANY_REQUESTS",
                `Organization member limit reached. Maximum ${MEMBER_LIMIT} members allowed (${currentMemberCount} current, ${pendingCount} pending invitations).`,
            );
        }

        // Could check if user has opted out of organization invitations

        // Check for existing pending invitations and cancel them
        // Using the email_organizationId_status index for efficient lookup
        const existingInvitations = await getInvitationsByEmailOrganizationAndStatus(context, args.email, orgId, "pending", DEFAULT_LIST_LIMIT);

        // Cancel existing invitations by updating their status
        for (const existingInvitation of existingInvitations) {
            await patchInvitation(context, existingInvitation._id, { status: "canceled" });
        }

        // Check if user is already a member
        // Need to fetch all members and check emails (no direct email index on members)
        const existingMember = await getMembersByOrganization(context, orgId, DEFAULT_LIST_LIMIT);

        // Check if any member has the invited email
        for (const member of existingMember) {
            const memberUser = await getUser(context, member.userId);

            if (memberUser?.email === args.email) {
                throw new LunoraError("BAD_REQUEST", `${args.email} is already a member of this organization`);
            }
        }

        // Create new invitation via Better Auth API (triggers configured email)
        // Create new invitation directly
        try {
            const api = getBetterAuthApi(context);
            const { id: invitationId } = await api.createInvitation({
                email: args.email,
                organizationId: orgId,
                role: args.role,
            });

            if (!invitationId) {
                throw new LunoraError("INTERNAL_SERVER_ERROR", "Failed to create invitation");
            }
        } catch (error) {
            throw new LunoraError("BAD_REQUEST", `Failed to send invitation: ${error instanceof Error ? error.message : "Unknown error"}`);
        }

        context.log.event("organization.invite_member", { organizationId: orgId, role: args.role });
    });

// Cancel invitation
export const cancelInvitation = authMutation
    .use(rateLimit("organization/cancelInvite"))
    .input({
        invitationId: v.string().max(MAX_LENGTH.id),
    })
    .mutation(async ({ args, ctx: context }) => {
        const invitation = await getInvitation(context, args.invitationId);

        // Permission: invitation cancel and ownership of current active org
        await hasPermission(context, { permissions: { invitation: ["cancel"] } });

        if (!invitation || context.user.activeOrganization?.id !== invitation.organizationId) {
            throw new LunoraError("FORBIDDEN", "You do not have permission to cancel this invitation");
        }

        // Cancel the invitation in Better Auth
        try {
            const api = getBetterAuthApi(context);

            await api.cancelInvitation({ invitationId: args.invitationId });
        } catch (error) {
            const message = error instanceof Error ? error.message : "";

            if (message.includes("not found")) {
                throw new LunoraError("NOT_FOUND", "Invitation not found or already processed");
            }

            throw new LunoraError("BAD_REQUEST", `Failed to cancel invitation: ${message || "Unknown error"}`);
        }

        // Note: Email cancellation through Resend is non-critical
        // The invitation being cancelled is the primary action
        context.log.event("organization.cancel_invitation", { invitationId: args.invitationId });
    });
