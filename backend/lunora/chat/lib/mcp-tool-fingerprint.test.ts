import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { FINGERPRINT_DEADLINE_MS, fingerprintMcpTool, mcpToolDrift } from "./mcp-tool-fingerprint";

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
const SOURCE = { protocol: "http", serverName: "Docs", toolName: "search", url: "https://docs.example.com/mcp" };

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

    it("is the same when a server lists an enum's values in another order", async () => {
        const sorted: JSONSchema7 = { ...SEARCH_SCHEMA, properties: { scope: { enum: ["docs", "issues", "code"], type: "string" } } };
        const shuffled: JSONSchema7 = { ...SEARCH_SCHEMA, properties: { scope: { enum: ["code", "docs", "issues"], type: "string" } } };

        expect(await fingerprintMcpTool(mcpTool(shuffled), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(sorted), SOURCE));
    });

    it("changes when the server is reached over another transport at the same address", async () => {
        const tool = mcpTool(SEARCH_SCHEMA);

        expect(await fingerprintMcpTool(tool, { ...SOURCE, protocol: "sse" })).not.toBe(await fingerprintMcpTool(tool, SOURCE));
    });

    it("is the same when a type union or object-valued enum is listed in another order", async () => {
        const listed = (type: JSONSchema7["type"], choices: JSONSchema7["enum"]): JSONSchema7 => {
            return { ...SEARCH_SCHEMA, properties: { filter: { enum: choices, type } } };
        };
        const first = listed(["string", "object"], [{ field: "title", op: "eq" }, "any"]);
        // The member's keys in another order too: built from reversed entries, since the lint sort would reorder a literal.
        const member = Object.fromEntries(Object.entries({ field: "title", op: "eq" }).toReversed());
        const reordered = listed(["object", "string"], ["any", member]);

        expect(Object.keys(member)).toStrictEqual(["op", "field"]);

        expect(await fingerprintMcpTool(mcpTool(reordered), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(first), SOURCE));
    });

    it("keeps the order of a list inside data, so two different constants never hash alike", async () => {
        const withConst = (types: string[]): JSONSchema7 => {
            return { ...SEARCH_SCHEMA, properties: { mode: { const: { type: types } } } };
        };

        expect(await fingerprintMcpTool(mcpTool(withConst(["b", "a"])), SOURCE)).not.toBe(await fingerprintMcpTool(mcpTool(withConst(["a", "b"])), SOURCE));
    });

    it("sorts the sets of a property whose NAME is a keyword, such as one called default", async () => {
        const named = (required: string[]): JSONSchema7 => {
            return {
                ...SEARCH_SCHEMA,
                properties: {
                    default: { properties: { a: { type: "string" }, b: { type: "string" } }, required, type: "object" },
                },
            };
        };

        expect(await fingerprintMcpTool(mcpTool(named(["b", "a"])), SOURCE)).toBe(await fingerprintMcpTool(mcpTool(named(["a", "b"])), SOURCE));
    });

    it("gives up on a schema that never resolves, instead of holding up the run", async () => {
        vi.useFakeTimers();

        try {
            const pending = fingerprintMcpTool(mcpTool(new Promise<JSONSchema7>(() => {})), SOURCE);
            const settled = expect(pending).rejects.toThrow("did not resolve");

            await vi.advanceTimersByTimeAsync(FINGERPRINT_DEADLINE_MS + 1);
            await settled;
        } finally {
            vi.useRealTimers();
        }
    });

    it("is the same when a dependency's property names are listed in another order", async () => {
        const withDependencies = (names: string[]): JSONSchema7 => {
            return { ...SEARCH_SCHEMA, dependencies: { query: names } };
        };

        expect(await fingerprintMcpTool(mcpTool(withDependencies(["b", "a"])), SOURCE)).toBe(
            await fingerprintMcpTool(mcpTool(withDependencies(["a", "b"])), SOURCE),
        );
    });

    it("keeps the order of a constant inside a dependency's subschema", async () => {
        const withDependency = (values: string[]): JSONSchema7 => {
            return { ...SEARCH_SCHEMA, dependencies: { query: { properties: { mode: { const: values } } } } };
        };

        expect(await fingerprintMcpTool(mcpTool(withDependency(["b", "a"])), SOURCE)).not.toBe(
            await fingerprintMcpTool(mcpTool(withDependency(["a", "b"])), SOURCE),
        );
    });

    it("changes when an enum gains a value", async () => {
        const listed = (choices: string[]): JSONSchema7 => {
            return { ...SEARCH_SCHEMA, properties: { scope: { enum: choices, type: "string" } } };
        };

        expect(await fingerprintMcpTool(mcpTool(listed(["docs", "code"])), SOURCE)).not.toBe(await fingerprintMcpTool(mcpTool(listed(["docs"])), SOURCE));
    });

    it("changes when a connector's tool now goes to another address", async () => {
        const tool = mcpTool(SEARCH_SCHEMA);
        const connector = { ...SOURCE, connectorSlug: "notion" };

        expect(await fingerprintMcpTool(tool, { ...connector, url: "https://elsewhere.example.com/mcp" })).not.toBe(await fingerprintMcpTool(tool, connector));
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
        expect(mcpToolDrift(saved, { mcp_Docs__search: "aaa" }, "mcp_Docs__search", true)).toBe("unchanged");
    });

    it("is changed when the fingerprint differs", () => {
        expect(mcpToolDrift(saved, { mcp_Docs__search: "bbb" }, "mcp_Docs__search", true)).toBe("changed");
    });

    it("is unverified, not removed, when the tool is still offered but has no fingerprint this time", () => {
        expect(mcpToolDrift(saved, {}, "mcp_Docs__search", true)).toBe("unverified");
    });

    it("is removed when the tool is no longer offered", () => {
        expect(mcpToolDrift(saved, {}, "mcp_Docs__search", false)).toBe("removed");
    });

    it("is unchanged for a tool the snapshot did not fingerprint, or a snapshot that predates fingerprints", () => {
        expect(mcpToolDrift(saved, {}, "webSearch", false)).toBe("unchanged");
        expect(mcpToolDrift(undefined, {}, "mcp_Docs__search", false)).toBe("unchanged");
    });
});
