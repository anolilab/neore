/**
 * The agent-side device proxy: runtime names, the wait for a call (offline,
 * deadline, abort, a late finish), what the model is told, the per-run cap and
 * the taint it signs into each call.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { DEVICE_CALL_DEADLINE_MS, DEVICE_CLAIM_WINDOW_MS, MAX_DEVICE_CALLS_PER_RUN } from "../../devices/lib/constants";
import { awaitDeviceCall, buildDeviceTools, deviceRuntimeToolName, toDeviceToolOutput } from "./device-tools";

type State = { createdAt: number; deadline: number; error?: string; output?: string; status: string };

/** A fake action ctx over one call row whose state the test scripts. */
const fakeCtx = (states: State[], options: { context?: unknown } = {}) => {
    const expired: string[] = [];
    const created: Record<string, unknown>[] = [];
    let index = 0;

    const ctx = {
        runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
            if (ref === internal.devices.internal.expireDeviceCall) {
                expired.push(args.reason as string);

                return { ...states[Math.min(index, states.length - 1)], error: args.reason, status: "expired" };
            }

            created.push(args);

            return { callId: "call-1" };
        }),
        runQuery: vi.fn(async (ref: unknown) => {
            if (ref === internal.devices.internal.getDeviceToolContext) {
                return options.context ?? null;
            }

            const state = states[Math.min(index, states.length - 1)];

            index += 1;

            return state;
        }),
    };

    return { created, ctx, expired };
};

const noSleep = async () => {};

describe("deviceRuntimeToolName", () => {
    it("is device_<tag>__<tool>, at most 64 characters, collision-suffixed", () => {
        const taken = new Set<string>();
        const first = deviceRuntimeToolName("k57abcdefXYZ123", "fs_read", taken);

        expect(first).toBe("device_xyz123__fs_read");
        taken.add(first);
        expect(deviceRuntimeToolName("k57abcdefXYZ123", "fs_read", taken)).toBe("device_xyz123__fs_read_2");
        expect(deviceRuntimeToolName("dev", `mcp__${"x".repeat(80)}`).length).toBeLessThanOrEqual(64);
    });
});

describe("awaitDeviceCall", () => {
    it("returns the finished state", async () => {
        const { ctx, expired } = fakeCtx([
            { createdAt: 0, deadline: DEVICE_CALL_DEADLINE_MS, status: "claimed" },
            { createdAt: 0, deadline: DEVICE_CALL_DEADLINE_MS, output: "done", status: "completed" },
        ]);

        await expect(awaitDeviceCall(ctx, "call-1" as never, { now: () => 1000, sleep: noSleep })).resolves.toMatchObject({ status: "completed" });
        expect(expired).toEqual([]);
    });

    it("gives up as offline when nobody claims within the claim window", async () => {
        const { ctx, expired } = fakeCtx([{ createdAt: 0, deadline: DEVICE_CALL_DEADLINE_MS, status: "pending" }]);

        await awaitDeviceCall(ctx, "call-1" as never, { now: () => DEVICE_CLAIM_WINDOW_MS + 1, sleep: noSleep });
        expect(expired).toEqual(["The user's device is offline."]);
    });

    it("gives up at the deadline even while the device holds it (unanswered prompt)", async () => {
        const { ctx, expired } = fakeCtx([{ createdAt: 0, deadline: DEVICE_CALL_DEADLINE_MS, status: "claimed" }]);

        await awaitDeviceCall(ctx, "call-1" as never, { now: () => DEVICE_CALL_DEADLINE_MS + 1, sleep: noSleep });
        expect(expired).toEqual(["The device did not answer in time."]);
    });

    it("stops when the run is aborted", async () => {
        const { ctx, expired } = fakeCtx([{ createdAt: 0, deadline: DEVICE_CALL_DEADLINE_MS, status: "claimed" }]);

        await awaitDeviceCall(ctx, "call-1" as never, { abortSignal: AbortSignal.abort(), now: () => 1, sleep: noSleep });
        expect(expired).toEqual(["The run was stopped."]);
    });
});

describe("toDeviceToolOutput", () => {
    it("tells the model what happened", () => {
        expect(toDeviceToolOutput({ createdAt: 0, deadline: 0, exitCode: 0, output: "ok", status: "completed" })).toEqual({
            exitCode: 0,
            ok: true,
            output: "ok",
        });
        expect(toDeviceToolOutput({ createdAt: 0, deadline: 0, status: "denied" })).toMatchObject({ ok: false });
        expect(toDeviceToolOutput({ createdAt: 0, deadline: 0, error: "offline", status: "expired" })).toEqual({
            error: "offline",
            ok: false,
            status: "expired",
        });
        expect(toDeviceToolOutput(null)).toMatchObject({ ok: false });
    });
});

describe("buildDeviceTools", () => {
    const context = {
        devices: [
            {
                deviceId: "dev000001",
                name: "Laptop",
                tools: [{ description: "Read", inputSchema: { properties: {}, type: "object" }, kind: "fs", name: "fs_read", readOnly: true }],
            },
        ],
    };

    it("builds nothing for an ineligible thread", async () => {
        const { ctx } = fakeCtx([]);

        await expect(buildDeviceTools(ctx as never, { threadId: "t", userId: "u" })).resolves.toMatchObject({ tools: {} });
    });

    it("signs the taint of what the model read into the call, and caps calls per run", async () => {
        const { created, ctx } = fakeCtx([{ createdAt: 0, deadline: Number.MAX_SAFE_INTEGER, output: "body", status: "completed" }], { context });
        const { descriptors, tools } = await buildDeviceTools(ctx as never, { threadId: "t", userId: "u" });
        const [name] = [...descriptors.keys()];
        const { execute } = tools[name!] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
        const messages = [{ content: [{ toolName: "webSearch", type: "tool-result" }], role: "tool" }];

        await expect(execute({ path: "a" }, { messages, toolCallId: "1" })).resolves.toMatchObject({ ok: true, output: "body" });
        expect(created[0]).toMatchObject({ input: '{"path":"a"}', taintedBy: ["web"], toolName: "fs_read" });

        for (let call = 1; call < MAX_DEVICE_CALLS_PER_RUN; call += 1) {
            await execute({}, { messages: [], toolCallId: String(call) });
        }

        await expect(execute({}, { messages: [], toolCallId: "last" })).resolves.toMatchObject({ ok: false });
        expect(created).toHaveLength(MAX_DEVICE_CALLS_PER_RUN);
    });
});
