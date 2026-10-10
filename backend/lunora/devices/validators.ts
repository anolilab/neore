import { v } from "lunorash/server";

/**
 * Device execution (`docs/plans/device-execution.md`): validators shared by the
 * schema, the procedures and the chat tool proxy.
 */

export const vDevicePlatform = v.union(v.literal("macos"), v.literal("windows"), v.literal("linux"));

/**
 * A call's lifecycle. `pending` waits for the device to claim it, `claimed` is
 * on the device (approval prompt or running); the rest are terminal.
 */
export const vDeviceCallStatus = v.union(
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("denied"),
    v.literal("expired"),
);

/**
 * Where a `claimed` call is on the device, as its signed progress reports say:
 * `prompting` — the local approval window is showing it; `running` — approved
 * (or allowed by a rule) and executing. Display only; the result is what counts.
 */
export const vDeviceCallPhase = v.union(v.literal("prompting"), v.literal("running"));

/** Untrusted content the model saw before a call (`lib/taint.ts`). Signed into the envelope. */
export const vDeviceTaintSource = v.union(v.literal("web"), v.literal("knowledge"), v.literal("mcp"), v.literal("device"), v.literal("files"));

export const vDeviceToolKind = v.union(v.literal("fs"), v.literal("shell"), v.literal("mcp"));

/** One tool of a device's signed manifest, as stored after verification. */
export const vDeviceManifestTool = v.object({
    description: v.string(),
    /** JSON Schema of the input; always `type: "object"` (checked in `lib/manifest.ts`). */
    inputSchema: v.any(),
    kind: vDeviceToolKind,
    name: v.string(),
    readOnly: v.boolean(),
});

/** What `listDevices` returns per device. The secret never leaves the backend. */
export const vDeviceView = v.object({
    _id: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    name: v.string(),
    platform: vDevicePlatform,
    toolNames: v.array(v.string()),
});

/** One audit row, as `listDeviceCalls` shows it. */
export const vDeviceCallView = v.object({
    _id: v.string(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    decision: v.optional(v.string()),
    deviceId: v.string(),
    deviceName: v.string(),
    error: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    input: v.string(),
    output: v.optional(v.string()),
    status: vDeviceCallStatus,
    taintedBy: v.array(vDeviceTaintSource),
    threadId: v.string(),
    toolName: v.string(),
    truncated: v.optional(v.boolean()),
});

/** One device call as the chat's tool row shows it (`getDeviceCallByToolCall`). No input, output or envelope. */
export const vDeviceCallStatusView = v.object({
    _id: v.string(),
    deviceName: v.string(),
    phase: v.optional(vDeviceCallPhase),
    status: vDeviceCallStatus,
    toolName: v.string(),
});
