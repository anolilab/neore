/**
 * Device tools: the agent-side proxy for tools that run on the user's own
 * computer through the desktop shell (`docs/plans/device-execution.md`).
 *
 * One AI SDK tool per entry of each online device's verified manifest. Calling
 * one creates a signed `deviceCalls` row (`devices/internal.ts`), which the
 * shell's page picks up over its live query; the device asks the user in a
 * LOCAL window, runs it and returns a signed result. This side only waits:
 * it polls the row with backoff until it is terminal, the claim window or
 * deadline passes, or the run is aborted.
 *
 * The tools exist only for interactive runs in a thread the user owns alone
 * (`getDeviceToolContext`); `buildAgentTools` never asks for them headless.
 */
import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import {
    DEVICE_CLAIM_WINDOW_MS,
    DEVICE_POLL_INITIAL_MS,
    DEVICE_POLL_MAX_MS,
    MAX_DEVICE_CALLS_PER_RUN,
    MAX_DEVICE_OUTPUT_BYTES,
} from "../../devices/lib/constants";
import type { DeviceManifestTool } from "../../devices/lib/manifest";
import { capUtf8 } from "../../devices/lib/signing";
import { computeTaint } from "../../devices/lib/taint";
import { toolsLogger } from "../../lib/logger";

/** Where a device runtime tool goes. The runtime name alone cannot say. */
export interface DeviceToolDescriptor {
    deviceId: string;
    deviceName: string;
    toolName: string;
}

export interface DeviceToolsResult {
    descriptors: Map<string, DeviceToolDescriptor>;
    tools: ToolSet;
}

const MAX_TOOL_NAME = 64;

/**
 * Runtime name the model sees: `device_<last 6 of the id>__<tool>`, at most 64
 * characters (the providers' limit). Collisions get `_2`, `_3`, … in encounter
 * order — deterministic for the same devices in the same order, which is what a
 * resumed run rebuilds.
 */
export const deviceRuntimeToolName = (deviceId: string, toolName: string, taken: { has: (name: string) => boolean } = new Set()): string => {
    const tag = deviceId
        .replaceAll(/[^a-z0-9]/giu, "")
        .slice(-6)
        .toLowerCase();
    const base = `device_${tag}__${toolName}`.slice(0, MAX_TOOL_NAME - 3);
    let name = base;
    let suffix = 1;

    while (taken.has(name)) {
        suffix += 1;
        name = `${base}_${String(suffix)}`;
    }

    return name;
};

/**
 * What the model gets back. `status` says how a failed call ended, so the chat
 * can word it ("denied on …", "expired") without parsing the English `error`.
 */
export type DeviceToolOutput =
    | { error: string; ok: false; output?: string; status?: "denied" | "expired" | "failed" }
    | { exitCode?: number; ok: true; output: string; truncated?: boolean };

interface CallState {
    createdAt: number;
    deadline: number;
    error?: string;
    exitCode?: number;
    output?: string;
    status: "claimed" | "completed" | "denied" | "expired" | "failed" | "pending";
    truncated?: boolean;
}

const CREATE_ERRORS: Record<string, string> = {
    busy: "The device already has several actions waiting for approval. Wait for the user to answer them before asking again.",
    ineligible: "This device tool is not available in this conversation.",
    input_too_large: "The input for this device tool is too large.",
    offline: "The user's device is offline.",
    rate_limited: "Too many device actions in a short time. Try again later.",
};

/** What the model gets back for a terminal call. */
export const toDeviceToolOutput = (state: CallState | null): DeviceToolOutput => {
    if (!state) {
        return { error: "The device action disappeared.", ok: false };
    }

    const output = state.output === undefined ? undefined : capUtf8(state.output, MAX_DEVICE_OUTPUT_BYTES).text;

    switch (state.status) {
        case "completed": {
            return {
                ok: true,
                output: output ?? "",
                ...(state.exitCode !== undefined && { exitCode: state.exitCode }),
                ...(state.truncated === true && { truncated: true }),
            };
        }
        case "denied": {
            return { error: "The user denied this action on their device. Do not retry it unless they ask.", ok: false, status: "denied" };
        }
        case "failed": {
            return { error: state.error ?? "The device action failed.", ok: false, status: "failed", ...(output !== undefined && { output }) };
        }
        default: {
            return { error: state.error ?? "The device did not answer in time.", ok: false, status: "expired" };
        }
    }
};

const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

type DeviceCtx = Pick<ActionCtx, "runMutation" | "runQuery">;

/**
 * Waits for a call to finish. Gives up — marking it expired, so a late
 * approval on the device can never run it — when nobody claimed it within the
 * claim window, its deadline passed, or the run was aborted.
 */
export const awaitDeviceCall = async (
    ctx: DeviceCtx,
    callId: Id<"deviceCalls">,
    options: { abortSignal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CallState | null> => {
    const now = options.now ?? Date.now;
    const wait = options.sleep ?? sleep;
    let delay = DEVICE_POLL_INITIAL_MS;

    for (;;) {
        const state = (await ctx.runQuery(internal.devices.internal.getDeviceCallState, { callId })) as CallState | null;

        if (!state || (state.status !== "pending" && state.status !== "claimed")) {
            return state;
        }

        let reason: string | undefined;

        if (options.abortSignal?.aborted) {
            reason = "The run was stopped.";
        } else if (state.status === "pending" && now() - state.createdAt > DEVICE_CLAIM_WINDOW_MS) {
            reason = "The user's device is offline.";
        } else if (now() > state.deadline) {
            reason = "The device did not answer in time.";
        }

        if (reason !== undefined) {
            return (await ctx.runMutation(internal.devices.internal.expireDeviceCall, { callId, reason })) as CallState | null;
        }

        await wait(delay);
        delay = Math.min(delay * 2, DEVICE_POLL_MAX_MS);
    }
};

/**
 * The device tools an interactive run in `threadId` gets — none when the
 * thread is not eligible or no device is online.
 */
export const buildDeviceTools = async (ctx: DeviceCtx, options: { threadId: string; userId: string }): Promise<DeviceToolsResult> => {
    const { threadId, userId } = options;
    const context = await ctx.runQuery(internal.devices.internal.getDeviceToolContext, { now: Date.now(), threadId: threadId as Id<"threads">, userId });
    const tools: ToolSet = {};
    const descriptors = new Map<string, DeviceToolDescriptor>();

    if (!context) {
        return { descriptors, tools };
    }

    // Per tool-set build = per run; a run resumed after a chat-side approval builds anew.
    let calls = 0;

    for (const device of context.devices) {
        for (const manifestTool of device.tools as DeviceManifestTool[]) {
            const runtimeName = deviceRuntimeToolName(device.deviceId, manifestTool.name, descriptors);

            descriptors.set(runtimeName, { deviceId: device.deviceId, deviceName: device.name, toolName: manifestTool.name });
            tools[runtimeName] = tool({
                description: `Runs on the user's own computer "${device.name}" and asks them to approve it there first. ${manifestTool.description}`,
                execute: async (input: unknown, { abortSignal, messages, toolCallId }): Promise<DeviceToolOutput> => {
                    calls += 1;

                    if (calls > MAX_DEVICE_CALLS_PER_RUN) {
                        return { error: `At most ${String(MAX_DEVICE_CALLS_PER_RUN)} device actions per reply.`, ok: false };
                    }

                    const created = await ctx.runMutation(internal.devices.internal.createDeviceCall, {
                        deviceId: device.deviceId as Id<"devices">,
                        input: JSON.stringify(input ?? {}),
                        taintedBy: computeTaint(messages),
                        threadId: threadId as Id<"threads">,
                        toolCallId,
                        toolName: manifestTool.name,
                        userId,
                    });

                    if ("error" in created) {
                        return { error: CREATE_ERRORS[created.error] ?? "The device action could not be started.", ok: false };
                    }

                    toolsLogger.debug(`[DEVICE] Call ${created.callId} → ${device.name}:${manifestTool.name}`);

                    return toDeviceToolOutput(await awaitDeviceCall(ctx, created.callId as Id<"deviceCalls">, { abortSignal }));
                },
                inputSchema: jsonSchema(manifestTool.inputSchema as Parameters<typeof jsonSchema>[0]),
            }) as ToolSet[string];
        }
    }

    return { descriptors, tools };
};
