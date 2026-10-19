import { describe, expect, it } from "vitest";

import { isCredentialRequest, signInInFlight, trackCredentialRequest, waitForCredentialRequests } from "./sign-in-lock";

describe("isCredentialRequest", () => {
    it("matches the paths that change who the caller is", () => {
        expect(isCredentialRequest("http://localhost/api/auth/sign-in/email")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/sign-in/anonymous")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/callback/google?code=1")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/two-factor/verify-totp")).toBe(true);
    });

    it("ignores reads and sign-out", () => {
        expect(isCredentialRequest("http://localhost/api/auth/get-session")).toBe(false);
        expect(isCredentialRequest("http://localhost/api/auth/token")).toBe(false);
        expect(isCredentialRequest("http://localhost/api/auth/sign-out")).toBe(false);
    });
});

describe("credential request tracking", () => {
    it("holds waiters until the request settles", async () => {
        // Held on an object rather than a bare `let`: a placeholder initializer
        // takes no arguments, so a static analyser reads `resolve("ok")` below as
        // passing one argument too many.
        const gate: { resolve: (value: string) => void } = { resolve: () => {} };
        const tracked = trackCredentialRequest(
            new Promise<string>((resolve) => {
                gate.resolve = resolve;
            }),
        );

        expect(signInInFlight()).toBe(true);

        let isReleased = false;

        const waiter = (async () => {
            await waitForCredentialRequests();

            isReleased = true;
        })();

        await Promise.resolve();
        expect(isReleased).toBe(false);

        gate.resolve("ok");
        await tracked;
        await waiter;

        expect(isReleased).toBe(true);
        expect(signInInFlight()).toBe(false);
    });

    it("releases when the request fails", async () => {
        const tracked = trackCredentialRequest(Promise.reject(new Error("offline")));

        await expect(tracked).rejects.toThrow("offline");
        expect(signInInFlight()).toBe(false);
    });
});
