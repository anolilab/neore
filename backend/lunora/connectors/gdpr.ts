/**
 * The connectors module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts`). A plain function over the caller's `ctx`.
 * The encrypted grant tokens are revoked earlier, by
 * `revokeUserConnectorGrants` in `gdpr/steps/residual-deletion-steps.ts`.
 */
import type { MutationCtx } from "../_generated/server";

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

    await Promise.all([
        ...userConnectors.map((uc) => ctx.db.delete(uc._id)),
        ...oauthStates.map((os) => ctx.db.delete(os._id)),
        ...mcpServerGrants.map((grant) => ctx.db.delete(grant._id)),
    ]);
};
