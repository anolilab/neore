import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { applyToolPermissions, BUILTIN_TOOLS_ASK_BY_DEFAULT, defaultToolPermission, resolveToolPermission, toolPermissionKey } from "./tool-permissions";

describe("defaultToolPermission", () => {
    it("defaults built-ins to auto", () => {
        expect(defaultToolPermission("builtin")).toBe("auto");
        // Annotations are an MCP concept; a built-in ignores them.
        expect(defaultToolPermission("builtin", { destructiveHint: true })).toBe("auto");
    });

    it("defaults MCP tools to ask without annotations", () => {
        expect(defaultToolPermission("mcp")).toBe("ask");
        expect(defaultToolPermission("mcp", {})).toBe("ask");
        expect(defaultToolPermission("mcp", { readOnlyHint: false })).toBe("ask");
    });

    it("defaults read-only MCP tools to auto", () => {
        expect(defaultToolPermission("mcp", { readOnlyHint: true })).toBe("auto");
        expect(defaultToolPermission("connector", { readOnlyHint: true })).toBe("auto");
    });

    it("never defaults a destructive tool to auto, even when it also claims read-only", () => {
        expect(defaultToolPermission("mcp", { destructiveHint: true })).toBe("ask");
        expect(defaultToolPermission("mcp", { destructiveHint: true, readOnlyHint: true })).toBe("ask");
    });
});

describe("askUser", () => {
    const askUser = { key: toolPermissionKey("builtin", "askUser"), source: "builtin" as const };

    it("is listed as asking, and stays in an interactive run", () => {
        expect(defaultToolPermission("builtin", undefined, "askUser")).toBe("ask");
        expect(resolveToolPermission(askUser, undefined)).toBe("ask");
    });

    it("is removed from a headless run, even when the user set it to auto", () => {
        expect(resolveToolPermission(askUser, undefined, { headless: true })).toBe("off");
        expect(resolveToolPermission(askUser, { "builtin:askUser": "auto" }, { headless: true })).toBe("off");
    });

    it("is removed from a headless run even when the run claims an inherited approval for it", () => {
        expect(resolveToolPermission(askUser, undefined, { headless: true, headlessApproved: new Set(["askUser"]) })).toBe("off");
    });
});

describe("sub-agent delegation", () => {
    const delegate = { key: toolPermissionKey("builtin", "delegateToSubAgent"), source: "builtin" as const };
    const inherited = { headless: true, headlessApproved: new Set(["delegateToSubAgent"]) };

    it("asks in an interactive chat by default", () => {
        expect(defaultToolPermission("builtin", undefined, "delegateToSubAgent")).toBe("ask");
        expect(resolveToolPermission(delegate, undefined)).toBe("ask");
    });

    it("is removed from a headless run that inherited no approval (triggers, tasks, messenger)", () => {
        expect(resolveToolPermission(delegate, undefined, { headless: true })).toBe("off");
    });

    it("runs as auto in a sub-agent child whose parent call was approved, so depth 2 stays reachable", () => {
        expect(resolveToolPermission(delegate, undefined, inherited)).toBe("auto");
    });

    it("never revives a tool the user turned off", () => {
        expect(resolveToolPermission(delegate, { "builtin:delegateToSubAgent": "off" }, inherited)).toBe("off");
    });

    it("grants only the named built-in, not other ask tools", () => {
        const coding = { key: toolPermissionKey("builtin", "delegateToCodingAgent"), source: "builtin" as const };

        expect(resolveToolPermission(coding, undefined, inherited)).toBe("off");
    });

    it("does not reach MCP tools that share the name", () => {
        const mcp = { key: toolPermissionKey("mcp", "delegateToSubAgent", "Evil"), source: "mcp" as const };

        expect(resolveToolPermission(mcp, undefined, inherited)).toBe("off");
    });
});

describe("coding-agent delegation default", () => {
    const delegate = { key: toolPermissionKey("builtin", "delegateToCodingAgent"), source: "builtin" as const };

    it("asks before every delegation unless the user chose otherwise", () => {
        expect(BUILTIN_TOOLS_ASK_BY_DEFAULT.has("delegateToCodingAgent")).toBe(true);
        expect(defaultToolPermission("builtin", undefined, "delegateToCodingAgent")).toBe("ask");
        expect(resolveToolPermission(delegate, undefined)).toBe("ask");
        expect(resolveToolPermission(delegate, { "builtin:delegateToCodingAgent": "auto" })).toBe("auto");
    });

    it("is absent on headless paths, where nobody can approve", () => {
        expect(resolveToolPermission(delegate, undefined, { headless: true })).toBe("off");
    });

    it("flags the tool for approval when a tool set is built", () => {
        const tools = { delegateToCodingAgent: { description: "d" }, webSearch: { description: "w" } } as unknown as ToolSet;
        const { requiresApproval, tools: result } = applyToolPermissions(tools, () => undefined, undefined);

        expect(requiresApproval).toEqual(["delegateToCodingAgent"]);
        expect((result["delegateToCodingAgent"] as { needsApproval?: boolean }).needsApproval).toBe(true);
        expect((result["webSearch"] as { needsApproval?: boolean }).needsApproval).toBeUndefined();
    });
});

describe("device tools", () => {
    const device = { key: toolPermissionKey("device", "shell_run", "dev1"), source: "device" as const };

    it("is keyed per device and tool", () => {
        expect(device.key).toBe("device:dev1:shell_run");
    });

    it("runs without a chat-side prompt — the device itself asks", () => {
        expect(resolveToolPermission(device, undefined)).toBe("auto");
    });

    it("is removed from every headless run, whatever the user set and whatever the run inherited", () => {
        expect(resolveToolPermission(device, { [device.key]: "auto" }, { headless: true })).toBe("off");
        expect(resolveToolPermission(device, undefined, { headless: true, headlessApproved: new Set(["shell_run"]) })).toBe("off");
    });

    it("still honours the user turning it off", () => {
        expect(resolveToolPermission(device, { [device.key]: "off" })).toBe("off");
    });
});

describe("resolveToolPermission", () => {
    const mcpWrite = { key: "mcp:Files:write", source: "mcp" as const };
    const builtin = { key: "builtin:webSearch", source: "builtin" as const };

    it("uses the default when there is no override", () => {
        expect(resolveToolPermission(builtin, undefined)).toBe("auto");
        expect(resolveToolPermission(mcpWrite, {})).toBe("ask");
    });

    it("prefers a user override over the default", () => {
        expect(resolveToolPermission(builtin, { "builtin:webSearch": "off" })).toBe("off");
        expect(resolveToolPermission(builtin, { "builtin:webSearch": "ask" })).toBe("ask");
        expect(resolveToolPermission(mcpWrite, { "mcp:Files:write": "auto" })).toBe("auto");
    });

    it("lets the user auto-allow a destructive tool explicitly", () => {
        expect(resolveToolPermission({ ...mcpWrite, annotations: { destructiveHint: true } }, { "mcp:Files:write": "auto" })).toBe("auto");
    });

    it("ignores an invalid stored value", () => {
        expect(resolveToolPermission(mcpWrite, { "mcp:Files:write": "yes" as never })).toBe("ask");
    });

    it("turns ask into off when headless", () => {
        expect(resolveToolPermission(mcpWrite, {}, { headless: true })).toBe("off");
        expect(resolveToolPermission(builtin, { "builtin:webSearch": "ask" }, { headless: true })).toBe("off");
    });

    it("keeps auto and off unchanged when headless", () => {
        expect(resolveToolPermission(builtin, {}, { headless: true })).toBe("auto");
        expect(resolveToolPermission(mcpWrite, { "mcp:Files:write": "auto" }, { headless: true })).toBe("auto");
        expect(resolveToolPermission(builtin, { "builtin:webSearch": "off" }, { headless: true })).toBe("off");
    });
});

describe("applyToolPermissions", () => {
    const makeTools = (): ToolSet =>
        ({
            datetime: { description: "datetime" },
            mcp_My_Server__delete: { description: "delete", metadata: { annotations: { destructiveHint: true } } },
            mcp_My_Server__read: { description: "read" },
            webSearch: { description: "search" },
        }) as unknown as ToolSet;

    // Stands in for `getMCPTools`'s descriptors: MCP tools are known by where
    // they came from, everything else falls through to the built-in key.
    const mcpDescriptors = new Map([
        ["mcp_My_Server__delete", { annotations: { destructiveHint: true }, key: toolPermissionKey("mcp", "delete", "My Server"), source: "mcp" as const }],
        ["mcp_My_Server__read", { annotations: { readOnlyHint: true }, key: toolPermissionKey("mcp", "read", "My Server"), source: "mcp" as const }],
    ]);
    const describeTool = (name: string) => mcpDescriptors.get(name);

    it("removes off tools, flags ask tools and passes auto tools through untouched", () => {
        const tools = makeTools();
        const result = applyToolPermissions(tools, describeTool, { "builtin:webSearch": "off" });

        expect(Object.keys(result.tools).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["datetime", "mcp_My_Server__delete", "mcp_My_Server__read"]);
        expect(result.removed).toStrictEqual(["webSearch"]);
        expect(result.requiresApproval).toStrictEqual(["mcp_My_Server__delete"]);
        expect((result.tools["mcp_My_Server__delete"] as { needsApproval?: unknown }).needsApproval).toBe(true);
        expect(result.tools["datetime"]).toBe(tools["datetime"]);
    });

    it("does not mutate the shared tool objects", () => {
        const tools = makeTools();

        applyToolPermissions(tools, describeTool, {});

        expect((tools["mcp_My_Server__delete"] as { needsApproval?: unknown }).needsApproval).toBeUndefined();
    });

    it("omits ask tools entirely on headless paths", () => {
        const result = applyToolPermissions(makeTools(), describeTool, {}, { headless: true });

        expect(Object.keys(result.tools)).not.toContain("mcp_My_Server__delete");
        expect(result.requiresApproval).toStrictEqual([]);
        expect(result.removed).toStrictEqual(["mcp_My_Server__delete"]);
    });
});
