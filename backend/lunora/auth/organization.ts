import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { DEFAULT_LIST_LIMIT, DEFAULT_PLAN } from "../lib/constants";
import { asyncMap } from "../lib/collections";
import { authQuery } from "../lib/crpc";
import { listUserOrganizations } from "./functions";
import { getOrganization, getOrganizationBySlug, getUser } from "./lib/better-auth-queries";
import { isOrganizationOwner } from "./lib/organization-helpers";
import { MAX_LENGTH } from "../lib/validators";

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
            const org = await getOrganization(context, invitation.organizationId);
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
