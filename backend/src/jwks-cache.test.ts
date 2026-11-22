/**
 * Key rotation: a token signed by a key the isolate has not seen yet verifies
 * after one forced re-read. An unknown `kid` from a stranger must not buy a
 * re-read per request, so forced re-reads are throttled per isolate.
 */
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { createJwksCache, JWKS_FORCED_RELOAD_INTERVAL_MS, JwksUnavailableError } from "./jwks-cache";

const ORIGIN = "https://api.example.test";

const keyPair = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");

    return { jwk: { ...(await exportJWK(publicKey)), alg: "ES256", kid }, kid, privateKey };
};

const tokenFor = async (key: Awaited<ReturnType<typeof keyPair>>) =>
    await new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "ES256", kid: key.kid })
        .setIssuer(ORIGIN)
        .setAudience(ORIGIN)
        .setExpirationTime("5m")
        .sign(key.privateKey);

describe("createJwksCache", () => {
    it("verifies a token signed by a rotated-in key after one forced re-read", async () => {
        const oldKey = await keyPair("old");
        const newKey = await keyPair("new");
        let published: JSONWebKeySet = { keys: [oldKey.jwk] };
        const load = vi.fn(async () => published);
        const cache = createJwksCache(load);

        await cache.verify(await tokenFor(oldKey), { audience: ORIGIN, issuer: ORIGIN });
        expect(load).toHaveBeenCalledTimes(1);

        published = { keys: [oldKey.jwk, newKey.jwk] };

        const { payload } = await cache.verify(await tokenFor(newKey), { audience: ORIGIN, issuer: ORIGIN });

        expect(payload.sub).toBe("user-1");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("re-reads for an unknown kid at most once per interval", async () => {
        const known = await keyPair("known");
        const stranger = await keyPair("stranger");
        const load = vi.fn(async (): Promise<JSONWebKeySet> => {
            return { keys: [known.jwk] };
        });
        let clock = 1_000_000;
        const cache = createJwksCache(load, () => clock);
        const forged = await tokenFor(stranger);

        await cache.verify(await tokenFor(known), { audience: ORIGIN, issuer: ORIGIN });

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await expect(cache.verify(forged, { audience: ORIGIN, issuer: ORIGIN })).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
        }

        // The initial read plus ONE forced re-read, not five.
        expect(load).toHaveBeenCalledTimes(2);

        clock += JWKS_FORCED_RELOAD_INTERVAL_MS;
        await expect(cache.verify(forged, { audience: ORIGIN, issuer: ORIGIN })).rejects.toThrow();
        expect(load).toHaveBeenCalledTimes(3);
    });

    it("reports a failed key read as unavailable (503), not as a bad token", async () => {
        const key = await keyPair("known");
        const cache = createJwksCache(async () => {
            throw new Error("D1_ERROR: timed out");
        });

        const failure = cache.verify(await tokenFor(key), { audience: ORIGIN, issuer: ORIGIN });

        await expect(failure).rejects.toBeInstanceOf(JwksUnavailableError);
        await expect(failure).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    });

    it("keeps reporting a rotated key's token as unavailable while the forced re-read that failed is throttled", async () => {
        const oldKey = await keyPair("old");
        const newKey = await keyPair("new");
        let isDown = false;
        const load = vi.fn(async (): Promise<JSONWebKeySet> => {
            if (isDown) {
                throw new Error("D1_ERROR: timed out");
            }

            return { keys: [oldKey.jwk, newKey.jwk] };
        });
        let clock = 1_000_000;
        const cache = createJwksCache(load, () => clock);

        // Cached with the old key only: the new key is unknown to it.
        load.mockImplementationOnce(async () => {
            return { keys: [oldKey.jwk] };
        });
        await cache.verify(await tokenFor(oldKey), { audience: ORIGIN, issuer: ORIGIN });

        isDown = true;
        const rotated = await tokenFor(newKey);

        // The forced re-read fails, and so does every try inside the throttle window: an outage, not a bad token.
        await expect(cache.verify(rotated, { audience: ORIGIN, issuer: ORIGIN })).rejects.toBeInstanceOf(JwksUnavailableError);
        await expect(cache.verify(rotated, { audience: ORIGIN, issuer: ORIGIN })).rejects.toBeInstanceOf(JwksUnavailableError);
        expect(load).toHaveBeenCalledTimes(2);

        // Once the keys can be read again, the token verifies.
        isDown = false;
        clock += JWKS_FORCED_RELOAD_INTERVAL_MS;

        const { payload } = await cache.verify(rotated, { audience: ORIGIN, issuer: ORIGIN });

        expect(payload.sub).toBe("user-1");
    });
});
