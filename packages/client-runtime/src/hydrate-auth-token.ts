interface TokenClient {
    getAuthToken: () => string | null;
    setAuthToken: (token: string | null) => void;
}

/** Clients already handed their SSR token — seeding is a once-per-client event. */
const seededClients = new WeakSet<TokenClient>();

/** The token each client was seeded with: the account the server rendered the page's data for. */
const seededTokens = new WeakMap<object, string>();

/**
 * The SSR token `seedHydratedAuthToken` handed this client, if it handed one. The live-query manager keeps the
 * hydrated thread reads only when this exact token is the first one the client adopts.
 */
export const hydratedAuthTokenOf = (client: object): string | undefined => seededTokens.get(client);

/**
 * Hands the browser's Lunora client the RPC token the root `beforeLoad` fetched
 * during SSR.
 *
 * The root `beforeLoad` is what calls `setAuthToken`, but on hydration it does
 * NOT run in the browser: router-core reuses the server's dehydrated
 * `beforeLoad` context for committed matches (`load-client.js`, the
 * `dehydratedMatches[index].b` spread). So after a full page load the browser
 * client had no token until the first client-side navigation re-ran
 * `beforeLoad` — while `useAuthState()` already read "authenticated", because
 * Lunora's identity probe (`getCurrentUser`, `credentials: "include"`) answers
 * from the session cookie. Every gate on `isAuthenticated` then fired RPCs with
 * no `authorization` header: 401s.
 *
 * Once per client, and only into an empty slot: a later sign-out sets the
 * token to null, and a re-render must not resurrect the stale SSR one.
 */
export const seedHydratedAuthToken = (client: TokenClient, token: string | null | undefined): void => {
    if (typeof window === "undefined" || seededClients.has(client)) {
        return;
    }

    seededClients.add(client);

    if (token && client.getAuthToken() === null) {
        seededTokens.set(client, token);
        client.setAuthToken(token);
    }
};
