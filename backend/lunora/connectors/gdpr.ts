/**
 * The connectors module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts`). A plain function over the caller's `ctx`.
 * The encrypted grant tokens are revoked earlier, by
 * `revokeUserConnectorGrants` in `gdpr/steps/residual-deletion-steps.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { deleteOneByOne } from "../gdpr/batch";

export const eraseConnectorsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const userConnectors = await ctx.db
        .query("userConnectors")
        .withIndex("by_user_and_definition", (q) => q.eq("userId", userId))
        .collect();

    // oauthStates are short-lived (10min), but an abandoned flow leaves a row
    // holding an encrypted PKCE verifier and possibly a DCR client secret.
    const oauthStates = await ctx.db
        .query("oauthStates")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
    // OAuth grants for the user's own MCP servers (revoked at the provider by
    // the earlier `revoke-connector-grants` step).
    const mcpServerGrants = await ctx.db
        .query("mcpServerGrants")
        .withIndex("by_user_and_server", (q) => q.eq("userId", userId))
        .collect();

    // A teammate's per-connection settings go with the account (`access.ts`).
    const teammateAccess = await ctx.db
        .query("teammateConnectorAccess")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    await Promise.all([
        ...userConnectors.map((uc) => ctx.db.delete("userConnectors", uc._id)),
        ...oauthStates.map((os) => ctx.db.delete("oauthStates", os._id)),
        ...mcpServerGrants.map((grant) => ctx.db.delete("mcpServerGrants", grant._id)),
    ]);

    // Audited rows: one at a time. Each delete fires an audit trigger, and a parallel batch of them nests the triggers past the
    // runtime's limit, which would fail the whole account deletion (`gdpr/batch.ts`).
    await deleteOneByOne(teammateAccess, (row) => ctx.db.delete("teammateConnectorAccess", row._id));
};
