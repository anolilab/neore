import { describe, expect, it, vi } from "vitest";

import { seedHydratedAuthToken } from "./hydrate-auth-token";

const createClient = (initial: string | null = null) => {
    let token = initial;

    return {
        getAuthToken: () => token,
        setAuthToken: vi.fn((next: string | null) => {
            token = next;
        }),
    };
};

describe(seedHydratedAuthToken, () => {
    it("hands a tokenless client the SSR token", () => {
        const client = createClient();

        seedHydratedAuthToken(client, "ssr-jwt");

        expect(client.getAuthToken()).toBe("ssr-jwt");
    });

    it("seeds once per client, so a sign-out is not undone by a re-render", () => {
        const client = createClient();

        seedHydratedAuthToken(client, "ssr-jwt");
        client.setAuthToken(null);
        seedHydratedAuthToken(client, "ssr-jwt");

        expect(client.getAuthToken()).toBeNull();
    });

    it("never overwrites a token the client already has", () => {
        const client = createClient("fresher-jwt");

        seedHydratedAuthToken(client, "ssr-jwt");

        expect(client.setAuthToken).not.toHaveBeenCalled();
    });

    it("does nothing without an SSR token", () => {
        const client = createClient();

        seedHydratedAuthToken(client, undefined);

        expect(client.setAuthToken).not.toHaveBeenCalled();
    });
});
