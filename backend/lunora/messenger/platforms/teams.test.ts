import type { JWK } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { BotFrameworkJwk, TeamsActivity } from "./teams";
import { isTrustedServiceUrl, parseTeamsActivity, verifyTeamsRequest } from "./teams";

const APP_ID = "00000000-1111-2222-3333-444444444444";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const NOW = new Date("2026-09-23T10:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });

    privateKey = pair.privateKey;
    publicJwk = await exportJWK(pair.publicKey);
});

const keys =
    (overrides: Partial<BotFrameworkJwk> = {}): (() => Promise<BotFrameworkJwk[]>) =>
    async () => [{ ...publicJwk, endorsements: ["msteams", "webchat"], kid: "key-1", kty: "RSA", use: "sig", ...overrides }];

const token = async (claims: Record<string, unknown> = {}, options: { exp?: number; kid?: string } = {}): Promise<string> =>
    await new SignJWT({ serviceUrl: SERVICE_URL, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "key-1", typ: "JWT" })
        .setIssuer("https://api.botframework.com")
        .setAudience(APP_ID)
        .setIssuedAt(nowSeconds - 60)
        .setNotBefore(nowSeconds - 60)
        .setExpirationTime(options.exp ?? nowSeconds + 3600)
        .sign(privateKey);

const activity: TeamsActivity = {
    channelId: "msteams",
    conversation: { id: "a:1conversation", tenantId: "tenant" },
    from: { aadObjectId: "aad-user", id: "29:1user", name: "Ada" },
    id: "1695463200000",
    serviceUrl: SERVICE_URL,
    text: "<at>Neore</at> what is the weather?",
    timestamp: NOW.toISOString(),
    type: "message",
};

describe("verifyTeamsRequest", () => {
    it("accepts a correctly signed Connector token", async () => {
        await expect(verifyTeamsRequest(`Bearer ${await token()}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(true);
    });

    it("rejects a missing or non-bearer header", async () => {
        await expect(verifyTeamsRequest(null, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
        await expect(verifyTeamsRequest(`Basic ${await token()}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
    });

    it("rejects the wrong audience or issuer", async () => {
        await expect(verifyTeamsRequest(`Bearer ${await token()}`, activity, "another-app", { getKeys: keys(), now: NOW })).resolves.toBe(false);

        const forged = await new SignJWT({ serviceUrl: SERVICE_URL })
            .setProtectedHeader({ alg: "RS256", kid: "key-1" })
            .setIssuer("https://evil.example")
            .setAudience(APP_ID)
            .setExpirationTime(nowSeconds + 3600)
            .sign(privateKey);

        await expect(verifyTeamsRequest(`Bearer ${forged}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
    });

    it("rejects a token signed by a key that is not in the JWKS", async () => {
        const other = await generateKeyPair("RS256");
        const forged = await new SignJWT({ serviceUrl: SERVICE_URL })
            .setProtectedHeader({ alg: "RS256", kid: "key-1" })
            .setIssuer("https://api.botframework.com")
            .setAudience(APP_ID)
            .setExpirationTime(nowSeconds + 3600)
            .sign(other.privateKey);

        await expect(verifyTeamsRequest(`Bearer ${forged}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
        await expect(verifyTeamsRequest(`Bearer ${await token({}, { kid: "unknown" })}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
    });

    it("rejects a key not endorsed for the activity's channel", async () => {
        await expect(verifyTeamsRequest(`Bearer ${await token()}`, activity, APP_ID, { getKeys: keys({ endorsements: ["skype"] }), now: NOW })).resolves.toBe(
            false,
        );
    });

    it("rejects a serviceUrl claim that does not match the activity", async () => {
        const wrong = await token({ serviceUrl: "https://smba.trafficmanager.net/amer/" });

        await expect(verifyTeamsRequest(`Bearer ${wrong}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
    });

    it("rejects a replayed token after it expired (beyond the 5-minute skew)", async () => {
        const expired = await token({}, { exp: nowSeconds - 301 });

        await expect(verifyTeamsRequest(`Bearer ${expired}`, activity, APP_ID, { getKeys: keys(), now: NOW })).resolves.toBe(false);
    });

    it("refetches the JWKS once for an unknown kid (key rollover)", async () => {
        const calls: boolean[] = [];
        const rolling = async (force: boolean): Promise<BotFrameworkJwk[]> => {
            calls.push(force);

            return force ? await keys()() : [];
        };

        await expect(verifyTeamsRequest(`Bearer ${await token()}`, activity, APP_ID, { getKeys: rolling, now: NOW })).resolves.toBe(true);
        expect(calls).toEqual([false, true]);
    });
});

describe("isTrustedServiceUrl", () => {
    it("allows Bot Connector and Teams hosts over https only", () => {
        expect(isTrustedServiceUrl("https://smba.trafficmanager.net/emea/")).toBe(true);
        expect(isTrustedServiceUrl("https://webchat.botframework.com/")).toBe(true);
        // eslint-disable-next-line unicorn/prefer-https -- the plain-http URL IS the case under test (it must be refused); the autofix rewrote it into a failing assertion
        expect(isTrustedServiceUrl("http://smba.trafficmanager.net/emea/")).toBe(false);
        expect(isTrustedServiceUrl("https://smba.trafficmanager.net.evil.com/")).toBe(false);
        expect(isTrustedServiceUrl("https://evilbotframework.com/")).toBe(false);
        expect(isTrustedServiceUrl("https://user:pw@smba.trafficmanager.net/")).toBe(false);
        expect(isTrustedServiceUrl(undefined)).toBe(false);
    });
});

describe("parseTeamsActivity", () => {
    it("parses a message and strips the bot's @-mention", () => {
        expect(parseTeamsActivity(activity)).toEqual({
            activityId: "1695463200000",
            chatId: "a:1conversation",
            eventId: "1695463200000",
            kind: "text",
            senderId: "aad-user",
            senderName: "Ada",
            serviceUrl: SERVICE_URL,
            text: "what is the weather?",
            timestampMs: NOW.getTime(),
        });
    });

    it("marks attachment-only messages it cannot fetch unsupported and skips non-message activities", () => {
        expect(parseTeamsActivity({ ...activity, attachments: [{ contentType: "image/png" }], text: "" })?.kind).toBe("unsupported");
        expect(parseTeamsActivity({ ...activity, type: "conversationUpdate" })).toBeNull();
        expect(parseTeamsActivity({ ...activity, type: "typing" })).toBeNull();
    });
});
