/**
 * Key rotation: a token signed by a key the isolate has not seen yet verifies
 * after one forced re-read. An unknown `kid` from a stranger must not buy a
 * re-read per request, so forced re-reads are throttled per isolate.
 */
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { createJwksCache, JWKS_FORCED_RELOAD_INTERVAL_MS } from "./jwks-cache";

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
});
