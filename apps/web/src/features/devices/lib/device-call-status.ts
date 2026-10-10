/**
 * Where a device tool call is, for its chat row (`components/device-tool-call.tsx`).
 *
 * While the call is in flight the live `deviceCalls` row says it: `pending`
 * (sent, the device has not picked it up), `claimed` (the device has it) and
 * its signed `phase` — `prompting` (the approval window shows it) or `running`.
 * Once the tool returned, its output says how it ended (`status` on a failed
 * `DeviceToolOutput`, `backend/lunora/chat/lib/device-tools.ts`).
 */
import type { ToolPart } from "@neore/chat-ui/types";

export type DeviceCallDisplay = "awaiting_approval" | "claimed" | "denied" | "done" | "expired" | "failed" | "not_approved" | "queued" | "running";

export interface LiveDeviceCall {
    phase?: "prompting" | "running";
    status: "claimed" | "completed" | "denied" | "expired" | "failed" | "pending";
}

const IN_FLIGHT_STATES: ReadonlySet<ToolPart["state"]> = new Set(["approval-responded", "input-available", "input-streaming"]);

/** Whether the tool has not returned yet — the only time the row reads the live call. */
export const isDeviceCallInFlight = (part: Pick<ToolPart, "state">): boolean => IN_FLIGHT_STATES.has(part.state);

const fromOutput = (output: unknown): DeviceCallDisplay => {
    const result = output as { ok?: unknown; status?: unknown } | null | undefined;

    if (result?.ok === true) {
        return "done";
    }

    if (result?.status === "denied" || result?.status === "expired") {
        return result.status;
    }

    return "failed";
};

const fromLive = (call: LiveDeviceCall | null | undefined): DeviceCallDisplay => {
    switch (call?.status) {
        case "claimed": {
            if (call.phase === "running") {
                return "running";
            }

            return call.phase === "prompting" ? "awaiting_approval" : "claimed";
        }
        case "completed": {
            return "done";
        }
        case "denied":
        case "expired":
        case "failed": {
            return call.status;
        }
        default: {
            // Not created yet, or waiting for the device to pick it up.
            return "queued";
        }
    }
};

export const deviceCallDisplay = (part: Pick<ToolPart, "output" | "state">, live: LiveDeviceCall | null | undefined): DeviceCallDisplay => {
    if (part.state === "output-denied") {
        return "not_approved";
    }

    if (part.state === "output-error") {
        return "failed";
    }

    if (part.state === "output-available") {
        return fromOutput(part.output);
    }

    return fromLive(live);
};

/** Still moving: the row shows a spinner. */
const WAITING: ReadonlySet<DeviceCallDisplay> = new Set(["awaiting_approval", "claimed", "queued", "running"]);

export const isDeviceCallWaiting = (display: DeviceCallDisplay): boolean => WAITING.has(display);
