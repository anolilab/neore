/**
 * An organization's policy document: the owner writes it, every member of the
 * active organization reads it. Runs read its permission cap (`getPermissionCapQuery`);
 * the settings locks are enforced on the preference write path.
 *
 * The organization is always the caller's ACTIVE one (verified membership,
 * `resolveActiveMembership`), never an id from args, and the owner check is the
 * one `updateBillingSettings` applies.
 */
import { LunoraError, v } from "lunorash/server";

import { claimFence, ORGANIZATION_POLICY_CREATE_CLAIM_TTL_MS, ORGANIZATION_POLICY_CREATE_SCOPE, releaseClaim } from "../lib/claim-once";
import { authMutation, authQuery, internalQuery, rateLimit } from "../lib/crpc";
import { logger } from "../lib/logger";
import { MAX_LENGTH } from "../lib/validators";
import { parseOrganizationPolicy, permissionCapOf, readPolicyState, serializeOrganizationPolicy } from "./lib/organization-policy";

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

        const findRow = async () => await context.db.organizationPolicies.findFirst({ where: { organizationId } });
        let existing = await findRow();
        let createClaimedAt: number | null = null;

        // The organizationId index is not unique and global-table operations are not one transaction, so two first
        // writes through different shards could both insert revision 1. Only the writer that wins the claim creates.
        if (!existing) {
            createClaimedAt = await claimFence(context, ORGANIZATION_POLICY_CREATE_SCOPE, organizationId, {
                ttlMs: ORGANIZATION_POLICY_CREATE_CLAIM_TTL_MS,
            });

            if (createClaimedAt === null) {
                existing = await findRow();

                if (!existing) {
                    throw new LunoraError("CONFLICT", "The organization's policy is being created; try again.");
                }
            }
        }

        const revision = (existing?.revision ?? 0) + 1;
        const row = {
            document: serializeOrganizationPolicy(parsed.policy),
            revision,
            schemaVersion: parsed.policy.schemaVersion,
            updatedAt: context.now,
        };

        if (existing) {
            // Global-table operations are not one transaction, so another owner's write can land after the read above. The
            // patch only applies while the stored revision is still the one this writer read; otherwise the newer
            // document stays and this writer is told to retry, rather than answering a revision another writer also got.
            const { applied } = await context.db.patchIf("organizationPolicies", existing._id, { patch: row, where: { revision: existing.revision } });

            if (!applied) {
                throw new LunoraError("CONFLICT", "The organization's policy changed while it was being saved; try again.");
            }
        } else {
            try {
                await context.db.insert("organizationPolicies", { ...row, organizationId });
            } catch (error) {
                // The claim guards an insert that did not happen, so give it back: a retry creates the row now instead of
                // waiting out the claim's TTL. The fence keeps a late release from removing a newer writer's claim, and a
                // failed release must not hide the insert error.
                if (createClaimedAt !== null) {
                    await releaseClaim(context, ORGANIZATION_POLICY_CREATE_SCOPE, organizationId, createClaimedAt).catch(() => undefined);
                }

                throw error;
            }
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

/**
 * The broadest tool mode an organization's runs may use (`org-policy.md` §6a), read by the agent's tool assembly.
 * Internal: runs read it, no client calls it. A policy that cannot be read caps its runs at `ask`.
 */
export const getPermissionCapQuery = internalQuery
    .input({ organizationId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.literal("off"), v.literal("ask"), v.literal("auto")))
    .query(async ({ args, ctx: context }) => {
        const row = await context.db.organizationPolicies.findFirst({ where: { organizationId: args.organizationId } });
        const state = readPolicyState(row?.document);

        if (state.kind === "unreadable") {
            policyLogger.error("A stored organization policy no longer parses; its runs are capped at ask", { organizationId: args.organizationId });
        }

        return permissionCapOf(state);
    });
