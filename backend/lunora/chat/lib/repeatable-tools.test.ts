import { describe, expect, it, vi } from "vitest";

import { createToolRunMarker } from "./mark-tool-runs";
import { isSafeToRepeat } from "./repeatable-tools";

describe(isSafeToRepeat, () => {
    it("repeats only the built-ins named as read-only", () => {
        expect(isSafeToRepeat("webSearch", undefined)).toBe(true);
        expect(isSafeToRepeat("searchMemory", { source: "builtin" })).toBe(true);
        expect(isSafeToRepeat("imageGeneration", undefined)).toBe(false);
        expect(isSafeToRepeat("delegateToSubAgent", undefined)).toBe(false);
    });

    it("repeats a server's tool only when it says it reads and nothing riskier", () => {
        expect(isSafeToRepeat("mcp_docs__get", { annotations: { readOnlyHint: true }, source: "mcp" })).toBe(true);
        expect(isSafeToRepeat("get", { annotations: { readOnlyHint: true }, source: "connector" })).toBe(true);
        expect(isSafeToRepeat("mcp_docs__get", { source: "mcp" })).toBe(false);
        expect(isSafeToRepeat("mcp_docs__get", { annotations: { readOnlyHint: false }, source: "mcp" })).toBe(false);
        expect(isSafeToRepeat("mcp_docs__get", { annotations: { destructiveHint: true, readOnlyHint: true }, source: "mcp" })).toBe(false);
        expect(isSafeToRepeat("mcp_docs__get", { annotations: { openWorldHint: true, readOnlyHint: true }, source: "mcp" })).toBe(false);
    });

    it("never repeats a device tool, and never a built-in name on another source", () => {
        expect(isSafeToRepeat("webSearch", { annotations: { readOnlyHint: true }, source: "device" })).toBe(false);
        expect(isSafeToRepeat("webSearch", { source: "mcp" })).toBe(false);
    });
});

describe("a tool that is safe to repeat", () => {
    const marker = (runMutation = vi.fn(async (_reference: unknown, _args: Record<string, unknown>) => null), resumable = true) => {
        return {
            runMutation,
            toolRuns: createToolRunMarker({ runMutation } as never, { epoch: 0, isResumable: () => resumable, onReplaced: () => undefined, streamId: "s1" }),
        };
    };
    const toolSet = { act: { execute: async () => "acted" }, look: { execute: async () => "looked" } };

    it("is checked against the stream before it runs but never counted, and leaves nothing to release", async () => {
        const { runMutation, toolRuns } = marker();
        const tools = toolRuns.wrap(toolSet, new Set(["look"]));

        await expect(tools.look.execute()).resolves.toBe("looked");
        await toolRuns.release();

        expect(runMutation.mock.calls.map(([, args]) => args)).toStrictEqual([{ delta: 1, epoch: 0, repeatable: true, streamId: "s1" }]);
    });

    it("is counted like any tool when it is not named", async () => {
        const { runMutation, toolRuns } = marker();
        const tools = toolRuns.wrap(toolSet, new Set(["look"]));

        await tools.act.execute();
        await toolRuns.release();

        expect(runMutation.mock.calls.map(([, args]) => args)).toStrictEqual([
            { delta: 1, epoch: 0, streamId: "s1" },
            { delta: 0, epoch: 0, setTo: 0, streamId: "s1" },
        ]);
    });

    it("still runs through a shard hiccup on a resumable run, which stops an unsafe tool", async () => {
        const failing = vi.fn(async () => {
            throw new Error("shard unreachable");
        });
        const { toolRuns } = marker(failing as never);
        const tools = toolRuns.wrap(toolSet, new Set(["look"]));

        await expect(tools.look.execute()).resolves.toBe("looked");
        await expect(tools.act.execute()).rejects.toThrow("shard unreachable");
    });

    it("is stopped when the stream ended or a newer run holds it", async () => {
        const { LunoraError } = await import("lunorash/server");
        const ended = vi.fn(async () => {
            throw new LunoraError("CONFLICT", "The stream is no longer live");
        });
        const { toolRuns } = marker(ended as never);

        await expect(toolRuns.wrap(toolSet, new Set(["look"])).look.execute()).rejects.toThrow("no longer live");
    });
});
