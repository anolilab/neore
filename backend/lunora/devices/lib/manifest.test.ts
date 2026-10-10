import { describe, expect, it } from "vitest";

import { MAX_MANIFEST_TOOLS } from "./constants";
import { parseManifestTools } from "./manifest";

const tool = (overrides: Record<string, unknown> = {}) => {
    return {
        description: "Reads a file",
        inputSchema: { properties: { path: { type: "string" } }, type: "object" },
        kind: "fs",
        name: "fs_read",
        readOnly: true,
        ...overrides,
    };
};

describe("parseManifestTools", () => {
    it("accepts a well-formed tool list", () => {
        expect(parseManifestTools([tool(), tool({ kind: "shell", name: "shell_run", readOnly: false })])).toHaveLength(2);
    });

    it.each([
        ["a bad name", { name: "Fs Read" }],
        ["an unknown kind", { kind: "network" }],
        ["a non-object schema", { inputSchema: { type: "string" } }],
        ["a missing readOnly", { readOnly: undefined }],
    ])("refuses %s", (_label, overrides) => {
        expect(parseManifestTools([tool(overrides)])).toBeNull();
    });

    it("refuses duplicates, too many tools and oversized schemas", () => {
        expect(parseManifestTools([tool(), tool()])).toBeNull();
        expect(parseManifestTools(Array.from({ length: MAX_MANIFEST_TOOLS + 1 }, (_, index) => tool({ name: `t${String(index)}` })))).toBeNull();
        expect(parseManifestTools([tool({ inputSchema: { description: "x".repeat(20_000), type: "object" } })])).toBeNull();
    });

    it("truncates long descriptions", () => {
        expect(parseManifestTools([tool({ description: "x".repeat(5000) })])?.[0]?.description).toHaveLength(2000);
    });
});
