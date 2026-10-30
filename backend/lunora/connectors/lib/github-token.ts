/**
 * The user's GitHub connector token, for REST calls the backend makes itself
 * (opening a pull request, reading one). Actions only: it decrypts, and it may
 * call the token endpoint.
 */
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import type { ConnectorGrant } from "./grant-runtime";
import { obtainAccessToken } from "./grant-runtime";

export type GithubTokenOutcome = { accessToken: string } | { problem: "expired" | "not_connected" };

/** Tells "never connected" from "connected, but the grant no longer yields a token". */
export const resolveGithubToken = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<GithubTokenOutcome> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];
    const grant = grants.find((candidate) => candidate.slug === "github");

    if (!grant) {
        return { problem: "not_connected" };
    }

    const outcome = await obtainAccessToken(ctx, grant);

    return "error" in outcome ? { problem: "expired" } : { accessToken: outcome.accessToken };
};

/** Whether a GitHub grant exists, without touching its token. */
export const hasGithubGrant = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<boolean> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as Pick<ConnectorGrant, "slug">[];

    return grants.some((grant) => grant.slug === "github");
};
