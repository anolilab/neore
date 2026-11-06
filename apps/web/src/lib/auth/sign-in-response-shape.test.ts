/**
 * What `authClient.signIn.email` resolves to with `fetchOptions: { throw: true }`, which the sign-in form reads
 * `twoFactorRedirect` from (`sign-in-form.tsx`): better-fetch returns the response body itself, not a
 * `{ data, error }` wrapper. Driven through the real better-auth client with the same plugins.
 */
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { describe, expect, it } from "vitest";

const clientAnswering = (body: object) =>
    createAuthClient({
        baseURL: "http://localhost:3000",
        fetchOptions: {
            customFetchImpl: async () => Response.json(body),
        },
        // `onTwoFactorRedirect` set, so the plugin does not try to navigate in the test.
        plugins: [twoFactorClient({ onTwoFactorRedirect: () => undefined })],
    });

describe("signIn.email with throw: true", () => {
    it("resolves to the body, so twoFactorRedirect is a top-level field", async () => {
        const response = (await clientAnswering({ twoFactorRedirect: true }).signIn.email({
            email: "ada@example.com",
            fetchOptions: { throw: true },
            password: "correct horse battery",
        })) as Record<string, unknown>;

        expect(response.twoFactorRedirect).toBe(true);
        expect(response).not.toHaveProperty("data");
    });
});
