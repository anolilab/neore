/**
 * The user's GitHub connector token, for REST calls the backend makes itself
 * (opening a pull request, reading one). Actions only: it decrypts, and it may
 * call the token endpoint.
 */
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import type { ConnectorGrant } from "./grant-runtime";
import { obtainAccessToken } from "./grant-runtime";

export type GithubTokenOutcome = { accessToken: string; renew: () => Promise<GithubTokenOutcome> } | { problem: "expired" | "not_connected" | "unavailable" };

type TokenResult = Awaited<ReturnType<typeof obtainAccessToken>>;

/** Tells "never connected" from "connected, but the grant no longer yields a token". */
export const resolveGithubToken = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<GithubTokenOutcome> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];
    const grant = grants.find((candidate) => candidate.slug === "github");

    if (!grant) {
        return { problem: "not_connected" };
    }

    const outcomeOf = (result: TokenResult): GithubTokenOutcome => {
        if ("error" in result) {
            return { problem: result.expired ? "expired" : "unavailable" };
        }

        // `renew` forces a refresh, for a token the host refused before its stored expiry.
        return { accessToken: result.accessToken, renew: async () => outcomeOf(await obtainAccessToken(ctx, grant, undefined, { force: true })) };
    };

    return outcomeOf(await obtainAccessToken(ctx, grant));
};

/** Whether a GitHub grant exists, without touching its token. */
export const hasGithubGrant = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<boolean> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as Pick<ConnectorGrant, "slug">[];

    return grants.some((grant) => grant.slug === "github");
};
