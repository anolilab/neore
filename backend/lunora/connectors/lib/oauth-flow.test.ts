/**
 * PKCE and `state` for the connector OAuth flow: generation, and the checks
 * `consumeOAuthState` applies — expiry, replay (single use) and ownership.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../../schema";
import { consumeOAuthState, createOAuthState } from "../store";
import { checkOAuthState, OAUTH_STATE_TTL_MS } from "./oauth-state";
import { codeChallengeS256, generateCodeVerifier, generateOAuthState, hashOAuthState } from "./pkce";

const BASE64URL_43 = /^[\w-]{43}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

describe("PKCE", () => {
    it("produces an RFC 7636 verifier: 43 unreserved characters", () => {
        const verifier = generateCodeVerifier();

        expect(verifier).toMatch(BASE64URL_43);
        expect(generateCodeVerifier()).not.toBe(verifier);
    });

    it("derives the S256 challenge from RFC 7636 appendix B", async () => {
        await expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    it("generates unguessable states and stores only their hash", async () => {
        const state = generateOAuthState();

        expect(state).toMatch(BASE64URL_43);
        await expect(hashOAuthState(state)).resolves.toMatch(SHA256_HEX);
        await expect(hashOAuthState(state)).resolves.not.toContain(state);
    });
});

describe("checkOAuthState", () => {
    const row = { expiresAt: 1000, userId: "alice" };

    it("accepts the owner before expiry", () => {
        expect(checkOAuthState(row, "alice", 999)).toStrictEqual({ ok: true });
    });

    it("refuses another user", () => {
        expect(checkOAuthState(row, "mallory", 999)).toStrictEqual({ ok: false, reason: "wrong_user" });
    });

    it("refuses at and after expiry", () => {
        expect(checkOAuthState(row, "alice", 1000)).toStrictEqual({ ok: false, reason: "expired" });
    });

    it("refuses a missing (never issued, or already used) state", () => {
        expect(checkOAuthState(null, "alice", 0)).toStrictEqual({ ok: false, reason: "not_found" });
    });
});

/** Internal procedures are unreachable from the harness's RPC boundary; call them the way production does. */
const call = async (harness: ReturnType<typeof lunoraTest>, reference: unknown, args: unknown): Promise<any> =>
    await harness.run(async (context: any) => await context.runMutation(reference, args));

describe("consumeOAuthState", () => {
    const flow = {
        clientId: "client",
        clientSource: "dcr" as const,
        encryptedCodeVerifier: "v1:ciphertext",
        issuer: "https://auth.example",
        redirectUri: "https://app.example/dashboard/settings/connectors/callback",
        resource: "https://mcp.example/mcp",
        scopes: [],
        tokenEndpoint: "https://auth.example/token",
        tokenEndpointAuthMethod: "none" as const,
    };

    const withState = async <T>(expiresAt: number, body: (harness: ReturnType<typeof lunoraTest>) => Promise<T>): Promise<T> => {
        const harness = lunoraTest(schema as never);

        try {
            await call(harness, createOAuthState, { expiresAt, flow, stateHash: "hash", target: { kind: "connector", slug: "notion" }, userId: "alice" });

            return await body(harness);
        } finally {
            harness.close();
        }
    };

    it("returns the flow once, then treats the state as unknown (replay)", async () => {
        await withState(Date.now() + OAUTH_STATE_TTL_MS, async (harness) => {
            const first = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "alice" });
            const replay = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "alice" });

            expect(first).toMatchObject({ flow: { clientId: "client" }, ok: true, target: { kind: "connector", slug: "notion" } });
            expect(replay).toStrictEqual({ ok: false, reason: "not_found" });
        });
    });

    it("reads a row written before `target` through its legacy slug and server columns", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                await context.db.insert("oauthStates", {
                    connectorSlug: "notion",
                    expiresAt: Date.now() + 60_000,
                    flow,
                    state: "legacy-connector",
                    userId: "alice",
                });
                await context.db.insert("oauthStates", {
                    connectorSlug: "mcp:Linear",
                    expiresAt: Date.now() + 60_000,
                    flow,
                    mcpServer: { name: "Linear", url: "https://mcp.linear.app/mcp" },
                    state: "legacy-server",
                    userId: "alice",
                });
            });

            await expect(call(harness, consumeOAuthState, { stateHash: "legacy-connector", userId: "alice" })).resolves.toMatchObject({
                target: { kind: "connector", slug: "notion" },
            });
            await expect(call(harness, consumeOAuthState, { stateHash: "legacy-server", userId: "alice" })).resolves.toMatchObject({
                target: { kind: "mcp", name: "Linear", url: "https://mcp.linear.app/mcp" },
            });
        } finally {
            harness.close();
        }
    });

    it("refuses another user WITHOUT consuming the owner's state", async () => {
        await withState(Date.now() + OAUTH_STATE_TTL_MS, async (harness) => {
            const stranger = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "mallory" });
            const owner = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "alice" });

            expect(stranger).toStrictEqual({ ok: false, reason: "wrong_user" });
            expect(owner).toMatchObject({ ok: true });
        });
    });

    it("refuses an expired state and deletes it", async () => {
        await withState(Date.now() - 1, async (harness) => {
            const expired = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "alice" });
            const again = await call(harness, consumeOAuthState, { stateHash: "hash", userId: "alice" });

            expect(expired).toStrictEqual({ ok: false, reason: "expired" });
            expect(again).toStrictEqual({ ok: false, reason: "not_found" });
        });
    });

    it("caps open flows per user, evicting the oldest", async () => {
        const harness = lunoraTest(schema as never);

        try {
            for (let index = 0; index < 12; index += 1) {
                await call(harness, createOAuthState, {
                    expiresAt: Date.now() + 60_000 + index,
                    flow,
                    stateHash: `hash-${index}`,
                    target: { kind: "connector", slug: "notion" },
                    userId: "alice",
                });
            }

            const rows = await harness.run(async (context: any) => await context.db.query("oauthStates").collect());

            expect(rows).toHaveLength(10);
            expect(rows.map((row: { state: string }) => row.state)).not.toContain("hash-0");
        } finally {
            harness.close();
        }
    });
});
