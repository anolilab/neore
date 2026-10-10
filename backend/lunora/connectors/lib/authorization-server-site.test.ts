/**
 * The same-site rule for a user-added MCP server's authorization server: every
 * endpoint the consent and the token exchange touch must share the server's
 * registrable domain, or the user must have trusted those hosts.
 */
import { describe, expect, it } from "vitest";

import { foreignAuthorizationServerHosts, isTrusted, registrableDomain } from "./authorization-server-site";

const notion = {
    authorizationEndpoint: "https://mcp.notion.com/authorize",
    issuer: "https://mcp.notion.com",
    registrationEndpoint: "https://mcp.notion.com/register",
    tokenEndpoint: "https://mcp.notion.com/token",
};

describe("registrableDomain", () => {
    it.each([
        ["mcp.notion.com", "notion.com"],
        ["notion.com", "notion.com"],
        ["api.example.co.uk", "example.co.uk"],
        ["a.b.example.com.au", "example.com.au"],
        ["evil.workers.dev", "evil.workers.dev"],
        ["deep.evil.github.io", "evil.github.io"],
        ["MCP.Linear.APP.", "linear.app"],
        ["203.0.113.7", "203.0.113.7"],
    ])("%s → %s", (host, expected) => {
        expect(registrableDomain(host)).toBe(expected);
    });

    it("keeps two tenants of a shared host apart", () => {
        expect(registrableDomain("attacker.workers.dev")).not.toBe(registrableDomain("victim.workers.dev"));
    });
});

describe("foreignAuthorizationServerHosts", () => {
    it("is empty for an authorization server on the MCP server's own site", () => {
        expect(
            foreignAuthorizationServerHosts("https://mcp.example.com/mcp", {
                authorizationEndpoint: "https://login.example.com/authorize",
                issuer: "https://login.example.com",
                tokenEndpoint: "https://api.example.com/token",
            }),
        ).toStrictEqual([]);
    });

    it("names another provider's authorization server that an attacker's server points at", () => {
        expect(foreignAuthorizationServerHosts("https://mcp.attacker.example/mcp", notion)).toStrictEqual(["mcp.notion.com"]);
    });

    it("catches a same-site issuer whose endpoints are elsewhere", () => {
        expect(
            foreignAuthorizationServerHosts("https://mcp.attacker.example/mcp", {
                ...notion,
                issuer: "https://auth.attacker.example",
                registrationEndpoint: "https://auth.attacker.example/register",
            }),
        ).toStrictEqual(["mcp.notion.com"]);
    });
});

describe("isTrusted", () => {
    it("trusts a same-site server without asking", () => {
        expect(isTrusted([], undefined)).toBe(true);
    });

    it("needs every foreign host covered", () => {
        expect(isTrusted(["auth.example.com"], ["auth.example.com"])).toBe(true);
        expect(isTrusted(["auth.example.com", "token.example.net"], ["auth.example.com"])).toBe(false);
        expect(isTrusted(["auth.example.com"], undefined)).toBe(false);
    });
});
