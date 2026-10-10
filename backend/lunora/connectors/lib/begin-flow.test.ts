/**
 * Starting a sign-in to a user's own MCP server whose authorization server is
 * on another site: nothing is registered or stored until the user confirms the
 * hosts, and the confirmed hosts travel with the flow to the grant.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { beginOAuthFlow, providerFailure } from "./begin-flow";
import { OAuthError } from "./mcp-oauth";

const mocks = vi.hoisted(() => {
    return {
        authorizationServer: {} as Record<string, string>,
        registerClient: vi.fn(async () => {
            return { clientId: "dyn", tokenEndpointAuthMethod: "none" as const };
        }),
    };
});

vi.mock("../../env", () => {
    return { SITE_URL: "https://app.example.com" };
});

vi.mock("./mcp-oauth", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./mcp-oauth")>();

    return {
        ...actual,
        discoverOAuth: async (mcpUrl: string) => {
            return { authorizationServer: mocks.authorizationServer, resource: mcpUrl };
        },
        registerClient: mocks.registerClient,
    };
});

beforeAll(() => {
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", btoa("k".repeat(32)));
});

const NOTION = {
    authorizationEndpoint: "https://mcp.notion.com/authorize",
    issuer: "https://mcp.notion.com",
    registrationEndpoint: "https://mcp.notion.com/register",
    tokenEndpoint: "https://mcp.notion.com/token",
};

const context = () => {
    const runMutation = vi.fn(async () => null);

    return { ctx: { runMutation, user: { userId: "alice" } } as never, runMutation };
};

const start = async (ctx: never, options: { kind: "connector" | "mcp"; trusted?: string[] }) =>
    await beginOAuthFlow(ctx, {
        authorizeParams: [],
        envClient: null,
        mcpUrl: "https://mcp.attacker.example/mcp",
        scopes: [],
        target: options.kind === "mcp" ? { kind: "mcp", name: "Tools", url: "https://mcp.attacker.example/mcp" } : { kind: "connector", slug: "notion" },
        ...(options.trusted && { trustedAuthorizationServerHosts: options.trusted }),
    });

describe("beginOAuthFlow for a user's own server", () => {
    it("asks for confirmation — registering and storing nothing — when the authorization server is on another site", async () => {
        mocks.authorizationServer = NOTION;
        mocks.registerClient.mockClear();

        const { ctx, runMutation } = context();

        await expect(start(ctx, { kind: "mcp" })).resolves.toStrictEqual({
            authorizationServerHosts: ["mcp.notion.com"],
            kind: "confirm",
            mcpServerHost: "mcp.attacker.example",
        });
        expect(mocks.registerClient).not.toHaveBeenCalled();
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("asks again when the trusted hosts do not cover the ones now in play", async () => {
        mocks.authorizationServer = NOTION;

        const { ctx } = context();

        await expect(start(ctx, { kind: "mcp", trusted: ["auth.other.example"] })).resolves.toMatchObject({ kind: "confirm" });
    });

    it("proceeds once the user trusts the hosts, and records them with the flow", async () => {
        mocks.authorizationServer = NOTION;

        const { ctx, runMutation } = context();
        const started = await start(ctx, { kind: "mcp", trusted: ["mcp.notion.com", "stale.example"] });

        expect(started).toMatchObject({ kind: "redirect" });
        expect(runMutation).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                target: { kind: "mcp", name: "Tools", trustedAuthorizationServerHosts: ["mcp.notion.com"], url: "https://mcp.attacker.example/mcp" },
            }),
        );
    });

    it("never asks for a same-site authorization server, nor for a catalogue connector", async () => {
        mocks.authorizationServer = {
            authorizationEndpoint: "https://auth.attacker.example/authorize",
            issuer: "https://auth.attacker.example",
            tokenEndpoint: "https://auth.attacker.example/token",
        };

        await expect(start(context().ctx, { kind: "mcp" })).resolves.toMatchObject({ kind: "redirect" });

        mocks.authorizationServer = NOTION;

        await expect(start(context().ctx, { kind: "connector" })).resolves.toMatchObject({ kind: "redirect" });
    });
});

describe("providerFailure", () => {
    it("shows our message and the spec's error code, never the provider's description", () => {
        const failure = providerFailure("Token exchange", new OAuthError("invalid_grant", "Token request failed", "Click https://evil.example"));

        expect(failure.message).toBe("Token exchange failed (invalid_grant: Token request failed)");
    });

    it("does not echo an error code that is not a token", () => {
        expect(providerFailure("Token exchange", new OAuthError("go to evil.example now", "Token request failed")).message).toContain("provider_error");
    });
});
