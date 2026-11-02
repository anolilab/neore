/**
 * An organization's policy document: the owner writes it, every member of the
 * active organization reads it. Nothing reads it to enforce anything yet.
 *
 * The organization is always the caller's ACTIVE one (verified membership,
 * `resolveActiveMembership`), never an id from args, and the owner check is the
 * one `updateBillingSettings` applies.
 */
import { LunoraError, v } from "lunorash/server";

import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { logger } from "../lib/logger";
import { MAX_LENGTH } from "../lib/validators";
import { parseOrganizationPolicy, serializeOrganizationPolicy } from "./lib/organization-policy";

const policyLogger = logger.scope("organization-policy");

/**
 * Replace the active organization's policy. Owner only. The document is raw
 * JSON text: it is parsed by `parseOrganizationPolicy`, which refuses what a
 * validator would silently strip, and nothing invalid is ever stored.
 */
export const setOrganizationPolicy = authMutation
    .use(rateLimit("organization/policy"))
    .input({ document: v.string().max(MAX_LENGTH.document) })
    .output(v.object({ revision: v.number() }))
    .mutation(async ({ args, ctx: context }) => {
        const organizationId = context.user.activeOrganization?.id;

        if (!organizationId) {
            throw new LunoraError("FORBIDDEN", "No active organization");
        }

        if (context.user.activeOrganization?.role !== "owner") {
            throw new LunoraError("FORBIDDEN", "Only organization owners can change the organization policy");
        }

        const parsed = parseOrganizationPolicy(args.document);

        if (!parsed.ok) {
            throw new LunoraError("BAD_REQUEST", parsed.error);
        }

        const existing = await context.db.organizationPolicies.findFirst({ where: { organizationId } });
        const revision = (existing?.revision ?? 0) + 1;
        const row = {
            document: serializeOrganizationPolicy(parsed.policy),
            revision,
            schemaVersion: parsed.policy.schemaVersion,
            updatedAt: Date.now(),
        };

        if (existing) {
            await context.db.patch("organizationPolicies", existing._id, row);
        } else {
            await context.db.insert("organizationPolicies", { ...row, organizationId });
        }

        context.log.event("organization.set_policy", { organizationId, revision });

        return { revision };
    });

/**
 * The active organization's policy and its revision, or `null` when the caller
 * has no active organization or the organization has set none.
 */
export const getOrganizationPolicy = authQuery
    .output(
        v.union(
            v.object({
                policy: v.object({
                    models: v.optional(v.object({ allowed: v.array(v.string()) })),
                    permissionCap: v.optional(v.union(v.literal("off"), v.literal("ask"), v.literal("auto"))),
                    schemaVersion: v.literal(1),
                    settings: v.optional(v.record(v.string(), v.object({ locked: v.boolean(), value: v.boolean() }))),
                }),
                revision: v.number(),
                updatedAt: v.number(),
            }),
            v.null(),
        ),
    )
    .query(async ({ ctx: context }) => {
        const organizationId = context.user.activeOrganization?.id;

        if (!organizationId) {
            return null;
        }

        const row = await context.db.organizationPolicies.findFirst({ where: { organizationId } });

        if (!row) {
            return null;
        }

        const parsed = parseOrganizationPolicy(row.document);

        if (!parsed.ok) {
            policyLogger.error("A stored organization policy no longer parses", { organizationId, reason: parsed.error });

            throw new LunoraError("INTERNAL", "The organization policy could not be read");
        }

        return { policy: parsed.policy, revision: row.revision, updatedAt: row.updatedAt };
    });
