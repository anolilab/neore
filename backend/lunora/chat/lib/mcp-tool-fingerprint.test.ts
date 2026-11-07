import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { fingerprintMcpTool, mcpToolDrift } from "./mcp-tool-fingerprint";

/** An MCP tool shaped like the ones the MCP client builds from a `tools/list` entry. */
const mcpTool = (schema: JSONSchema7 | PromiseLike<JSONSchema7>): ToolSet[string] =>
    dynamicTool({
        execute: async () => {
            return {};
        },
        inputSchema: jsonSchema(schema),
    }) as ToolSet[string];

const SEARCH_SCHEMA: JSONSchema7 = { additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"], type: "object" };
const SHORT_HASH = /^[0-9a-f]{32}$/u;
const SOURCE = { serverName: "Docs", toolName: "search", url: "https://docs.example.com/mcp" };

describe(fingerprintMcpTool, () => {
    it("is the same for the same tool, whatever order its server writes the schema's keys in", async () => {
        // Written in reverse order on purpose: the lint sort would undo the point of the test.
        const reordered = Object.fromEntries(Object.entries(SEARCH_SCHEMA).toReversed()) as JSONSchema7;

        expect(Object.keys(reordered)).not.toStrictEqual(Object.keys(SEARCH_SCHEMA));

        expect(await fingerprintMcpTool(mcpTool(reordered), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(SEARCH_SCHEMA), SOURCE));
    });

    it("changes when the input schema changes", async () => {
        const widened: JSONSchema7 = { ...SEARCH_SCHEMA, properties: { ...SEARCH_SCHEMA.properties, limit: { type: "number" } } };

        expect(await fingerprintMcpTool(mcpTool(widened), SOURCE)).not.toBe(await fingerprintMcpTool(mcpTool(SEARCH_SCHEMA), SOURCE));
    });

    it("is the same when a server lists the required fields in another order", async () => {
        const two: JSONSchema7 = { ...SEARCH_SCHEMA, properties: { limit: { type: "number" }, query: { type: "string" } }, required: ["query", "limit"] };

        expect(await fingerprintMcpTool(mcpTool({ ...two, required: ["limit", "query"] }), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(two), SOURCE));
    });

    it("is the same when only the annotations' display title changes", async () => {
        const tool = mcpTool(SEARCH_SCHEMA);
        const titled = (title: string) => {
            return { ...SOURCE, annotations: { readOnlyHint: true, title } as { readOnlyHint: boolean } };
        };

        expect(await fingerprintMcpTool(tool, titled("Search"))).toBe(await fingerprintMcpTool(tool, titled("Find docs")));
    });

    it("changes when the annotations change", async () => {
        const tool = mcpTool(SEARCH_SCHEMA);

        expect(await fingerprintMcpTool(tool, { ...SOURCE, annotations: { destructiveHint: true } })).not.toBe(
            await fingerprintMcpTool(tool, { ...SOURCE, annotations: { readOnlyHint: true } }),
        );
    });

    it("changes when a server of the same name now has another address", async () => {
        const tool = mcpTool(SEARCH_SCHEMA);

        expect(await fingerprintMcpTool(tool, { ...SOURCE, url: "https://other.example.com/mcp" })).not.toBe(await fingerprintMcpTool(tool, SOURCE));
    });

    it("reads a schema that resolves lazily, so it still counts", async () => {
        const widened: JSONSchema7 = { ...SEARCH_SCHEMA, properties: { limit: { type: "number" } } };

        expect(await fingerprintMcpTool(mcpTool(Promise.resolve(widened)), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(widened), SOURCE));
        expect(await fingerprintMcpTool(mcpTool(Promise.resolve(widened)), SOURCE)).not.toBe(await fingerprintMcpTool(mcpTool(SEARCH_SCHEMA), SOURCE));
    });

    it("is a short hash, not the schema", async () => {
        expect(await fingerprintMcpTool(mcpTool(SEARCH_SCHEMA), SOURCE)).toMatch(SHORT_HASH);
    });
});

describe(mcpToolDrift, () => {
    const saved = { mcp_Docs__search: "aaa" };

    it("is unchanged when the fingerprint matches", () => {
        expect(mcpToolDrift(saved, { mcp_Docs__search: "aaa" }, "mcp_Docs__search")).toBe("unchanged");
    });

    it("is changed when the fingerprint differs", () => {
        expect(mcpToolDrift(saved, { mcp_Docs__search: "bbb" }, "mcp_Docs__search")).toBe("changed");
    });

    it("is removed when the tool is no longer offered", () => {
        expect(mcpToolDrift(saved, {}, "mcp_Docs__search")).toBe("removed");
    });

    it("is unchanged for a tool the snapshot did not fingerprint, or a snapshot that predates fingerprints", () => {
        expect(mcpToolDrift(saved, {}, "webSearch")).toBe("unchanged");
        expect(mcpToolDrift(undefined, {}, "mcp_Docs__search")).toBe("unchanged");
    });
});
