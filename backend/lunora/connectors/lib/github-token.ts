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

const readGithubGrant = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<ConnectorGrant | undefined> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];

    return grants.find((candidate) => candidate.slug === "github");
};

/** Tells "never connected" from "connected, but the grant no longer yields a token". */
export const resolveGithubToken = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<GithubTokenOutcome> => {
    const grant = await readGithubGrant(ctx, userId);

    if (!grant) {
        return { problem: "not_connected" };
    }

    const outcomeOf = (result: TokenResult): GithubTokenOutcome => {
        if ("error" in result) {
            return { problem: result.expired ? "expired" : "unavailable" };
        }

        return { accessToken: result.accessToken, renew };
    };

    // Forces a refresh, for a token the host refused before its stored expiry. The grant is read again: a refresh
    // earlier in this request stored new tokens, and refreshing from the old ones would hand back the refused token.
    const renew = async (): Promise<GithubTokenOutcome> => {
        const current = await readGithubGrant(ctx, userId);

        return current ? outcomeOf(await obtainAccessToken(ctx, current, undefined, { force: true })) : { problem: "not_connected" };
    };

    return outcomeOf(await obtainAccessToken(ctx, grant));
};

/** Whether a GitHub grant exists, without touching its token. */
export const hasGithubGrant = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<boolean> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as Pick<ConnectorGrant, "slug">[];

    return grants.some((grant) => grant.slug === "github");
};
