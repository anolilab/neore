/**
 * The grant lifecycle against the real storage engine: refresh (compare-and-set),
 * status changes and disconnect. Every write that CLEARS an optional field goes
 * through `patchRow` (`lib/patch.ts`), because the engine refuses `undefined` in a patch — these
 * tests fail with "Cannot patch field … to undefined" if one slips back in.
 *
 * The harness has no `.global()` (D1) backend, so the rows are seeded directly
 * rather than through `saveConnectorGrant`, whose definition lookup is D1.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import {
    clearConnectorGrant,
    consumeOAuthState,
    createOAuthState,
    deleteMcpServerGrant,
    getOwnedConnectorGrant,
    listGrantsForRevocation,
    listMcpServerGrants,
    markConnectorStatus,
    saveMcpServerGrant,
    storeRefreshedTokens,
} from "./store";

type Harness = ReturnType<typeof lunoraTest>;

const mutate = async (harness: Harness, reference: unknown, args: unknown): Promise<any> =>
    await harness.run(async (context: any) => await context.runMutation(reference, args));

const read = async (harness: Harness, reference: unknown, args: unknown): Promise<any> =>
    await harness.run(async (context: any) => await context.runQuery(reference, args));

const oauthClient = {
    clientId: "dyn",
    clientSource: "dcr" as const,
    issuer: "https://mcp.notion.com",
    resource: "https://mcp.notion.com/mcp",
    tokenEndpoint: "https://mcp.notion.com/token",
    tokenEndpointAuthMethod: "none" as const,
};

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const seedGrant = async (): Promise<string> =>
    await harness.run(
        async (context: any) =>
            await context.db.insert("userConnectors", {
                connectedAt: 1,
                connectorDefinitionId: "definition-notion",
                encryptedTokens: "c1:first",
                hasRefreshToken: true,
                oauthClient,
                scopes: ["default"],
                status: "connected",
                tokenExpiresAt: 1000,
                userId: "alice",
            }),
    );

const connectorRef = (id: string) => {
    return { id, table: "userConnectors" as const };
};

const serverRef = (id: string) => {
    return { id, table: "mcpServerGrants" as const };
};

const rowOf = async (connectorId: string) => await harness.run(async (context: any) => await context.db.get(connectorId));

describe("grant lifecycle", () => {
    it("applies a refresh only against the ciphertext it was computed from", async () => {
        const connectorId = await seedGrant();

        await expect(
            mutate(harness, storeRefreshedTokens, {
                encryptedTokens: "c1:stale",
                expectedEncryptedTokens: "c1:other",
                grant: connectorRef(connectorId),
                hasRefreshToken: true,
            }),
        ).resolves.toStrictEqual({ applied: false, current: "c1:first" });
        // No expiry in the new pair: the old `tokenExpiresAt` must be CLEARED, not kept.
        await expect(
            mutate(harness, storeRefreshedTokens, {
                encryptedTokens: "c1:new",
                expectedEncryptedTokens: "c1:first",
                grant: connectorRef(connectorId),
                hasRefreshToken: true,
            }),
        ).resolves.toStrictEqual({ applied: true, current: "c1:new" });

        const row = await rowOf(connectorId);

        expect(row).toMatchObject({ encryptedTokens: "c1:new", status: "connected", userId: "alice" });
        expect(row.tokenExpiresAt).toBeUndefined();
    });

    it("records an error status, and a successful refresh clears it", async () => {
        const connectorId = await seedGrant();

        await mutate(harness, markConnectorStatus, { grant: connectorRef(connectorId), lastError: "boom", status: "error" });
        await expect(rowOf(connectorId)).resolves.toMatchObject({ lastError: "boom", status: "error" });

        await mutate(harness, storeRefreshedTokens, {
            encryptedTokens: "c1:new",
            expectedEncryptedTokens: "c1:first",
            grant: connectorRef(connectorId),
            hasRefreshToken: true,
            tokenExpiresAt: 5000,
        });

        const row = await rowOf(connectorId);

        expect(row).toMatchObject({ status: "connected", tokenExpiresAt: 5000 });
        expect(row.lastError).toBeUndefined();
    });

    it("disconnect drops every secret, and only for the owner", async () => {
        const connectorId = await seedGrant();

        await expect(mutate(harness, clearConnectorGrant, { connectorId, userId: "mallory" })).resolves.toBe(false);
        await expect(read(harness, getOwnedConnectorGrant, { connectorId, userId: "mallory" })).resolves.toBeNull();
        await expect(read(harness, getOwnedConnectorGrant, { connectorId, userId: "alice" })).resolves.toMatchObject({ encryptedTokens: "c1:first" });
        await expect(mutate(harness, clearConnectorGrant, { connectorId, userId: "alice" })).resolves.toBe(true);

        const row = await rowOf(connectorId);

        expect(row).toMatchObject({ connectorDefinitionId: "definition-notion", status: "disconnected", userId: "alice" });
        expect(row.encryptedTokens).toBeUndefined();
        expect(row.oauthClient).toBeUndefined();
        expect(row.tokenExpiresAt).toBeUndefined();
        await expect(read(harness, listGrantsForRevocation, { userId: "alice" })).resolves.toStrictEqual([]);
    });

    it("lists grants for GDPR revocation per user", async () => {
        await seedGrant();

        await expect(read(harness, listGrantsForRevocation, { userId: "alice" })).resolves.toStrictEqual([{ encryptedTokens: "c1:first", oauthClient }]);
        await expect(read(harness, listGrantsForRevocation, { userId: "mallory" })).resolves.toStrictEqual([]);
    });
});

describe("MCP server grants", () => {
    const saveServer = async (overrides: Record<string, unknown> = {}) =>
        await mutate(harness, saveMcpServerGrant, {
            encryptedTokens: "c1:linear",
            hasRefreshToken: true,
            oauthClient,
            scopes: [],
            serverName: "Linear",
            serverUrl: "https://mcp.linear.app/mcp",
            tokenExpiresAt: 1000,
            userId: "alice",
            ...overrides,
        });

    it("carries the server through the OAuth state to completion", async () => {
        const flow = {
            clientId: "dyn",
            clientSource: "dcr" as const,
            encryptedCodeVerifier: "c1:v",
            issuer: "https://mcp.linear.app",
            redirectUri: "https://app.example.com/cb",
            resource: "https://mcp.linear.app/mcp",
            scopes: [],
            tokenEndpoint: "https://mcp.linear.app/token",
            tokenEndpointAuthMethod: "none" as const,
        };

        const target = { kind: "mcp" as const, name: "Linear", trustedAuthorizationServerHosts: ["auth.example.com"], url: "https://mcp.linear.app/mcp" };

        await mutate(harness, createOAuthState, { expiresAt: Date.now() + 60_000, flow, stateHash: "h", target, userId: "alice" });

        await expect(mutate(harness, consumeOAuthState, { stateHash: "h", userId: "alice" })).resolves.toMatchObject({ ok: true, target });
    });

    it("upserts per server name, clearing a stale expiry and error", async () => {
        const { grantId } = await saveServer();

        await mutate(harness, markConnectorStatus, { grant: serverRef(grantId), lastError: "gone", status: "expired" });
        await expect(saveServer({ encryptedTokens: "c1:again", tokenExpiresAt: undefined })).resolves.toStrictEqual({ grantId });

        const [grant] = await read(harness, listMcpServerGrants, { userId: "alice" });

        expect(grant).toMatchObject({ encryptedTokens: "c1:again", serverName: "Linear", status: "connected" });
        expect(grant.tokenExpiresAt).toBeUndefined();
        expect(grant.lastError).toBeUndefined();
    });

    it("refreshes through the shared compare-and-set by grant id", async () => {
        const { grantId } = await saveServer();

        await expect(
            mutate(harness, storeRefreshedTokens, {
                encryptedTokens: "c1:new",
                expectedEncryptedTokens: "c1:linear",
                grant: serverRef(grantId),
                hasRefreshToken: true,
            }),
        ).resolves.toStrictEqual({ applied: true, current: "c1:new" });
    });

    it("keeps the authorization-server hosts the user trusted on the grant", async () => {
        await saveServer({ trustedAuthorizationServerHosts: ["auth.example.com"] });

        await expect(read(harness, listMcpServerGrants, { userId: "alice" })).resolves.toMatchObject([
            { serverName: "Linear", trustedAuthorizationServerHosts: ["auth.example.com"] },
        ]);
    });

    it("is included in GDPR revocation and deleted per owner", async () => {
        await saveServer();

        await expect(read(harness, listGrantsForRevocation, { userId: "alice" })).resolves.toStrictEqual([{ encryptedTokens: "c1:linear", oauthClient }]);
        await expect(mutate(harness, deleteMcpServerGrant, { serverName: "Linear", userId: "mallory" })).resolves.toBeNull();
        await expect(mutate(harness, deleteMcpServerGrant, { serverName: "Linear", userId: "alice" })).resolves.toStrictEqual({
            encryptedTokens: "c1:linear",
            oauthClient,
        });
        await expect(read(harness, listMcpServerGrants, { userId: "alice" })).resolves.toStrictEqual([]);
    });
});
