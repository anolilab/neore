/**
 * A run started with an API key pauses for a person, who approves it in the app. The continuation rebuilds the run
 * from its saved snapshot, and the tools it gets are still capped at `ask` with no device tool, whatever the user
 * set for their own runs. The pause is recorded the way a run records it, the approval is claimed the way the app
 * claims it, and the rebuilt tools are the ones `buildAgentTools` returns to the resumed run.
 */
import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { continueAfterToolApproval } from "./execute";
import { buildToolsForSearchMode } from "./lib/tool-builder";
import { buildAgentTools } from "./lib/agent-tools";
import { claimToolApproval } from "./lib/tool-approval-claim";
import { recordPendingToolApprovals } from "./tool-permissions";

const registry = vi.hoisted(() => new Map<string, unknown>());
const rebuilt = vi.hoisted(() => {
    return { results: [] as { tools: Record<string, { needsApproval?: unknown }> }[] };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The tool set the resumed run is handed; the model run after it is not under test.
vi.mock("./lib/agent-tools", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./lib/agent-tools")>();

    return {
        ...actual,
        buildAgentTools: vi.fn(async (...args: Parameters<typeof actual.buildAgentTools>) => {
            const result = await actual.buildAgentTools(...args);

            rebuilt.results.push(result as never);

            return result;
        }),
    };
});

const deviceTools = vi.hoisted(() => vi.fn());

vi.mock("./lib/device-tools", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./lib/device-tools")>()), buildDeviceTools: deviceTools };
});

const OWNER = "owner-1";

/** What a web-search run offers, plus a device tool. */
const BUILT_IN_TOOLS = Object.keys(buildToolsForSearchMode("web"));

const baseConfig = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: ANONYMOUS_FREE_MODEL,
    researchDepth: "balanced" as const,
    searchMode: "web",
    shouldAutoContinue: false,
    toolNames: [...BUILT_IN_TOOLS, "device_laptop__shell_run"],
};

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
    registerModule(registry, "chat_tool_permissions", await import("./tool-permissions"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    rebuilt.results = [];
    deviceTools.mockReset();
    deviceTools.mockResolvedValue({
        descriptors: new Map([["device_laptop__shell_run", { deviceId: "laptop", deviceName: "Laptop", toolName: "shell_run" }]]),
        tools: { device_laptop__shell_run: { description: "Run a command" } },
    });
    // The user lets their own runs use every tool without asking, device tools included.
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("aiUserPreferences", {
            toolPermissions: { ...Object.fromEntries(BUILT_IN_TOOLS.map((name) => [`builtin:${name}`, "auto"])), "device:laptop:shell_run": "auto" },
            userId: OWNER,
        });
    });
});

afterEach(() => {
    harness.close();
});

/** A paused run, as `finishRun` leaves it: the request on the assistant's turn and its snapshot. */
const pause = async (origin: "api-key" | undefined) =>
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "running", title: "Chat", userId: OWNER });
        const insert = async (order: number, message: Record<string, unknown>) =>
            await ctx.db.insert("messages", { message, order, status: "success", stepOrder: 0, text: "", threadId, tool: false, userId: OWNER });

        await insert(0, { content: "Search for it", role: "user" });
        await insert(1, {
            content: [
                { input: { query: "x" }, toolCallId: "call1", toolName: "webSearch", type: "tool-call" },
                { approvalId: "ap1", toolCallId: "call1", type: "tool-approval-request" },
            ],
            role: "assistant",
        });

        const streamId = await ctx.db.insert("persistentStreams", {
            expiresAt: Date.now() + 60_000,
            messageId: "m1",
            status: "pending",
            streamingConfig: { contentType: "text", model: baseConfig.model },
            threadId,
            userId: OWNER,
        });

        await ctx.runMutation(recordPendingToolApprovals, {
            approvalIds: ["ap1"],
            config: { ...baseConfig, ...(origin && { origin }) },
            threadId: String(threadId),
            userId: OWNER,
        });

        return { streamId: String(streamId), threadId: String(threadId) };
    });

/** The person approves, and the continuation runs with the claimed snapshot. */
const approve = async (ids: { streamId: string; threadId: string }) => {
    const claim = (await harness.run(
        async (ctx: any) => await claimToolApproval(ctx, { approvalId: "ap1", callerId: OWNER, decision: "approve", threadId: ids.threadId as never }),
    )) as { config?: typeof baseConfig & { origin?: "api-key" }; kind: string };

    expect(claim.kind).toBe("claimed");

    await harness.action(
        async (ctx: any) =>
            await ctx.runAction(continueAfterToolApproval, {
                approvalId: "ap1",
                approved: true,
                config: claim.config,
                streamId: ids.streamId,
                threadId: ids.threadId,
                userId: OWNER,
            }),
    );
};

describe("the continuation of a run started with an API key", () => {
    it("keeps the origin through the saved snapshot, and rebuilds no auto tool and no device tool", async () => {
        await approve(await pause("api-key"));

        expect(buildAgentTools).toHaveBeenCalledOnce();
        expect(vi.mocked(buildAgentTools).mock.calls[0]?.[1]).toMatchObject({ origin: "api-key" });
        expect(deviceTools).not.toHaveBeenCalled();

        const { tools } = rebuilt.results[0]!;

        expect(Object.keys(tools)).not.toContain("device_laptop__shell_run");
        expect(Object.keys(tools).length).toBeGreaterThan(1);

        for (const [name, tool] of Object.entries(tools)) {
            expect(tool.needsApproval, name).toBe(true);
        }
    });

    it("control: the same pause from the app keeps the user's auto tools and offers the device", async () => {
        await approve(await pause(undefined));

        expect(deviceTools).toHaveBeenCalledOnce();

        const { tools } = rebuilt.results[0]!;

        expect(Object.keys(tools)).toContain("device_laptop__shell_run");
        expect(Object.entries(tools).filter(([, tool]) => tool.needsApproval !== true).length).toBeGreaterThan(1);
    });
});
