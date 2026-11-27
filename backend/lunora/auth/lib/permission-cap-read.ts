/**
 * An organization's permission cap, read from its stored policy. Every reader goes through here, so a policy that no
 * longer parses is logged once per read, whichever path refused the run (a chat run, a computer worker or a coding-agent
 * task), and is capped at `ask` (`permissionCapOf`).
 */
import type { QueryCtx as QueryContext } from "../../_generated/server";
import { logger } from "../../lib/logger";
import type { PermissionCap } from "./organization-policy";
import { permissionCapOf, readPolicyState } from "./organization-policy";

const policyLogger = logger.scope("organization-policy");

export const readOrganizationPermissionCap = async (context: Pick<QueryContext, "db">, organizationId: string): Promise<PermissionCap> => {
    // From the primary: the policy table is global, and a regional replica can still hold the broader cap an admin just
    // tightened, which would let the next run keep tools the organization has taken away.
    const row = await context.db.organizationPolicies.findFirst({ consistency: "primary", where: { organizationId } });
    const state = readPolicyState(row?.document);

    if (state.kind === "unreadable") {
        policyLogger.error("A stored organization policy no longer parses; its runs are capped at ask", { organizationId });
    }

    return permissionCapOf(state);
};
