import { describe, expect, it } from "vitest";

import type { CatalogServer } from "./types";
import { applySetupValue, catalogServerToFormData, fillTemplate, findMissingSetupField, hasUnresolvedPlaceholder, isCatalogServerAdded } from "./utilities";

const SMITHERY: CatalogServer = {
    description: "Access the GitHub API",
    id: "ai.smithery/smithery-ai-github",
    remotes: [
        {
            headers: [{ description: "Smithery token", isRequired: true, isSecret: true, name: "Authorization", value: "Bearer {smithery_api_key}" }],
            protocol: "http",
            url: "https://server.smithery.ai/@smithery-ai/github/mcp",
            variables: [],
        },
    ],
    title: "smithery-ai-github",
};

const TEMPLATED: CatalogServer = {
    description: "",
    id: "ai.biel/mcp",
    remotes: [
        { headers: [], protocol: "sse", url: "https://mcp.biel.ai/sse/{project_slug}", variables: [] },
        {
            headers: [{ isRequired: false, isSecret: true, name: "X-Api-Key" }],
            protocol: "http",
            url: "https://{api_host}/v2/{project_slug}/mcp",
            variables: [
                { choices: ["api.biel.ai", "api.eu.biel.ai"], isRequired: true, isSecret: false, name: "api_host" },
                { description: "Project slug", isRequired: true, isSecret: false, name: "project_slug" },
            ],
        },
    ],
    title: "Biel",
};

describe("fillTemplate", () => {
    it("fills known values and leaves unknown placeholders visible", () => {
        expect(fillTemplate("https://{a}/{b}", { a: "x.example" })).toBe("https://x.example/{b}");
        expect(hasUnresolvedPlaceholder("https://x.example/{b}")).toBe(true);
        expect(hasUnresolvedPlaceholder("https://x.example/b")).toBe(false);
    });
});

describe("catalogServerToFormData", () => {
    it("prefills name, url, protocol and an empty auth header with a setup field for the token", () => {
        const form = catalogServerToFormData(SMITHERY);

        expect(form).toMatchObject({
            headers: [{ key: "Authorization", value: "" }],
            name: "smithery-ai-github",
            protocol: "http",
            url: "https://server.smithery.ai/@smithery-ai/github/mcp",
        });
        expect(form.setup?.fields).toStrictEqual([
            { description: "Smithery token", isRequired: true, isSecret: true, key: "smithery_api_key", label: "smithery_api_key" },
        ]);
        expect(findMissingSetupField(form)?.key).toBe("smithery_api_key");
    });

    it("composes the header from its template once the token is entered", () => {
        const form = applySetupValue(catalogServerToFormData(SMITHERY), "smithery_api_key", "sk-123");

        expect(form.headers).toStrictEqual([{ key: "Authorization", value: "Bearer sk-123" }]);
        expect(findMissingSetupField(form)).toBeUndefined();
    });

    it("prefers streamable HTTP, defaults a variable to its first choice, and labels a bare header by name", () => {
        const form = catalogServerToFormData(TEMPLATED);

        expect(form.protocol).toBe("http");
        expect(form.url).toBe("https://api.biel.ai/v2/{project_slug}/mcp");
        expect(form.setup?.fields.map((field) => [field.key, field.label])).toStrictEqual([
            ["api_host", "api_host"],
            ["project_slug", "project_slug"],
            ["X-Api-Key", "X-Api-Key"],
        ]);

        const filled = applySetupValue(form, "project_slug", "docs");

        expect(filled.url).toBe("https://api.biel.ai/v2/docs/mcp");
        // Optional header left blank → empty value, dropped by the save path.
        expect(filled.headers).toStrictEqual([{ key: "X-Api-Key", value: "" }]);
    });

    it("keeps headers the user added when a setup value changes", () => {
        const form = catalogServerToFormData(SMITHERY);
        const withExtra = { ...form, headers: [...form.headers, { key: "X-Custom", value: "1" }] };

        expect(applySetupValue(withExtra, "smithery_api_key", "t").headers).toStrictEqual([
            { key: "Authorization", value: "Bearer t" },
            { key: "X-Custom", value: "1" },
        ]);
    });

    it("adds a required field for a URL placeholder the registry did not declare", () => {
        const form = catalogServerToFormData({
            description: "",
            id: "x",
            remotes: [{ headers: [], protocol: "http", url: "https://mcp.example.com/{tenant}/mcp", variables: [] }],
            title: "X",
        });

        expect(form.setup?.fields.map((field) => [field.key, field.isRequired])).toStrictEqual([["tenant", true]]);
        expect(applySetupValue(form, "tenant", "acme").url).toBe("https://mcp.example.com/acme/mcp");
    });

    it("has no setup when nothing needs configuring", () => {
        const form = catalogServerToFormData({
            description: "",
            id: "x",
            remotes: [{ headers: [], protocol: "http", url: "https://a.example/mcp", variables: [] }],
            title: "X",
        });

        expect(form.setup).toBeUndefined();
    });
});

describe("isCatalogServerAdded", () => {
    it("matches an exact url and a filled-in template url", () => {
        expect(isCatalogServerAdded(SMITHERY, new Set(["https://server.smithery.ai/@smithery-ai/github/mcp"]))).toBe(true);
        expect(isCatalogServerAdded(TEMPLATED, new Set(["https://api.eu.biel.ai/v2/docs/mcp"]))).toBe(true);
        expect(isCatalogServerAdded(TEMPLATED, new Set(["https://api.eu.biel.ai/v2/docs/other"]))).toBe(false);
    });
});
