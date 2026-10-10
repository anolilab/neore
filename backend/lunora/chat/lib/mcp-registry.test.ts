import { describe, expect, it, vi } from "vitest";

import { buildRegistryUrl, fetchRegistryPage, normaliseRegistryEntry, normaliseRegistryResponse } from "./mcp-registry";

const OFFICIAL = "io.modelcontextprotocol.registry/official";

const entry = (server: Record<string, unknown>, status = "active") => {
    return { _meta: { [OFFICIAL]: { isLatest: true, status } }, server };
};

// Shapes copied from live `GET /v0.1/servers?version=latest` responses.
const SMITHERY = entry({
    description: "Access the GitHub API",
    name: "ai.smithery/smithery-ai-github",
    remotes: [
        {
            headers: [
                {
                    description: "Bearer token for Smithery authentication",
                    isRequired: true,
                    isSecret: true,
                    name: "Authorization",
                    value: "Bearer {smithery_api_key}",
                },
            ],
            type: "streamable-http",
            url: "https://server.smithery.ai/@smithery-ai/github/mcp",
        },
    ],
    repository: { source: "github", url: "https://github.com/smithery-ai/mcp-servers" },
    version: "1.0.0",
});

// Built rather than written literally: the insecure scheme IS the input under test,
// and a literal would be "fixed" to https by lint autofix, silently gutting the test.
const INSECURE = ["http", "://"].join("");

const STDIO_ONLY = entry({
    name: "io.github.someone/local-only",
    packages: [{ identifier: "local-only", registryType: "npm", transport: { type: "stdio" } }],
    version: "0.1.0",
});

describe("normaliseRegistryEntry", () => {
    it("maps a streamable-http remote to protocol http with its header inputs", () => {
        expect(normaliseRegistryEntry(SMITHERY)).toStrictEqual({
            description: "Access the GitHub API",
            id: "ai.smithery/smithery-ai-github",
            remotes: [
                {
                    headers: [
                        {
                            description: "Bearer token for Smithery authentication",
                            isRequired: true,
                            isSecret: true,
                            name: "Authorization",
                            value: "Bearer {smithery_api_key}",
                        },
                    ],
                    protocol: "http",
                    url: "https://server.smithery.ai/@smithery-ai/github/mcp",
                    variables: [],
                },
            ],
            repositoryUrl: "https://github.com/smithery-ai/mcp-servers",
            title: "smithery-ai-github",
            version: "1.0.0",
        });
    });

    it("maps sse and keeps URL variables keyed by name, with choices", () => {
        const result = normaliseRegistryEntry(
            entry({
                name: "ai.autorfp/mcp",
                remotes: [
                    {
                        type: "sse",
                        url: "https://{api_host}/mcp",
                        variables: { api_host: { choices: ["api.autorfp.ai", "api.eu.autorfp.ai"], description: "Region host", isRequired: true } },
                    },
                ],
                title: "AutoRFP",
                version: "2.0.0",
            }),
        );

        expect(result?.title).toBe("AutoRFP");
        expect(result?.remotes).toStrictEqual([
            {
                headers: [],
                protocol: "sse",
                url: "https://{api_host}/mcp",
                variables: [
                    { choices: ["api.autorfp.ai", "api.eu.autorfp.ai"], description: "Region host", isRequired: true, isSecret: false, name: "api_host" },
                ],
            },
        ]);
    });

    it("drops servers with no remote transport (stdio-only packages)", () => {
        expect(normaliseRegistryEntry(STDIO_ONLY)).toBeUndefined();
    });

    it("drops unknown transport types and non-https URLs but keeps the usable remote", () => {
        const result = normaliseRegistryEntry(
            entry({
                name: "com.example/mixed",
                remotes: [
                    { type: "websocket", url: "wss://example.com/mcp" },
                    { type: "streamable-http", url: `${INSECURE}insecure.example.com/mcp` },
                    { type: "sse", url: "https://example.com/sse" },
                ],
                version: "1.0.0",
            }),
        );

        expect(result?.remotes.map((remote) => [remote.protocol, remote.url])).toStrictEqual([["sse", "https://example.com/sse"]]);
    });

    it("drops deprecated and deleted entries, but accepts a missing status", () => {
        const server = { name: "com.example/x", remotes: [{ type: "sse", url: "https://example.com/sse" }], version: "1" };

        expect(normaliseRegistryEntry(entry(server, "deprecated"))).toBeUndefined();
        expect(normaliseRegistryEntry(entry(server, "deleted"))).toBeUndefined();
        expect(normaliseRegistryEntry({ server })).toBeDefined();
    });

    it("picks the first https icon and ignores data: or http icons", () => {
        const result = normaliseRegistryEntry(
            entry({
                icons: [{ src: "data:image/png;base64,AAAA" }, { src: `${INSECURE}a.example/icon.png` }, { src: "https://b.example/icon.svg" }],
                name: "com.example/icons",
                remotes: [{ type: "sse", url: "https://example.com/sse" }],
                version: "1",
                websiteUrl: "https://example.com",
            }),
        );

        expect(result?.icon).toBe("https://b.example/icon.svg");
        expect(result?.websiteUrl).toBe("https://example.com");
    });

    it("tolerates malformed fields instead of throwing", () => {
        expect(normaliseRegistryEntry(null)).toBeUndefined();
        expect(normaliseRegistryEntry({ server: { remotes: "nope" } })).toBeUndefined();

        const result = normaliseRegistryEntry(
            entry({
                name: "com.example/bad-headers",
                remotes: [{ headers: [null, { description: "no name" }, { name: "X-Key" }], type: "sse", url: "https://example.com/sse" }],
            }),
        );

        expect(result?.remotes[0]?.headers).toStrictEqual([{ isRequired: false, isSecret: false, name: "X-Key" }]);
        expect(result?.version).toBe("");
    });
});

describe("normaliseRegistryResponse", () => {
    it("filters, dedupes and forwards the cursor", () => {
        const page = normaliseRegistryResponse({
            metadata: { count: 3, nextCursor: "ai.smithery/zzz:1.0.0" },
            servers: [SMITHERY, STDIO_ONLY, SMITHERY],
        });

        expect(page.servers.map((server) => server.id)).toStrictEqual(["ai.smithery/smithery-ai-github"]);
        expect(page.nextCursor).toBe("ai.smithery/zzz:1.0.0");
    });

    it("omits nextCursor on the last page", () => {
        expect(normaliseRegistryResponse({ metadata: { count: 0 }, servers: [] })).toStrictEqual({ servers: [] });
    });

    it("throws on a body with no servers array", () => {
        expect(() => normaliseRegistryResponse({ error: "boom" })).toThrow(TypeError);
    });
});

describe("buildRegistryUrl", () => {
    it("always asks for the latest version and trims search", () => {
        const url = new URL(buildRegistryUrl({ cursor: "a/b:1.0.0", search: "  github  " }));

        expect(url.searchParams.get("version")).toBe("latest");
        expect(url.searchParams.get("cursor")).toBe("a/b:1.0.0");
        expect(url.searchParams.get("search")).toBe("github");
    });

    it("omits an empty search", () => {
        expect(new URL(buildRegistryUrl({ search: " ".repeat(3) })).searchParams.has("search")).toBe(false);
    });
});

describe("fetchRegistryPage", () => {
    const json = (body: unknown) => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

    it("follows the cursor while pages are mostly stdio-only, bounded in rounds", async () => {
        const fetchImpl = vi.fn(async () => json({ metadata: { nextCursor: "next" }, servers: [STDIO_ONLY] }));

        const page = await fetchRegistryPage({}, fetchImpl);

        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(page).toStrictEqual({ nextCursor: "next", servers: [] });
    });

    it("cancels the body and throws on a non-OK response", async () => {
        const response = new Response("upstream down", { status: 503 });
        const cancel = vi.spyOn(response.body!, "cancel");

        await expect(fetchRegistryPage({}, async () => response)).rejects.toThrow("503");
        expect(cancel).toHaveBeenCalled();
    });
});
