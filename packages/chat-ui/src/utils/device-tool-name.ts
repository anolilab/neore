import type { ToolPart } from "../types/message";

export interface DeviceToolName {
    /** The device's name, once the backend labelled the call; `undefined` while it streams. */
    deviceName?: string;
    toolName: string;
}

/**
 * `device_{last 6 of the device id}__{tool}`, with an optional `_2`, `_3`, …
 * collision suffix — `deviceRuntimeToolName` in `backend/lunora/chat/lib/device-tools.ts`.
 */
const DEVICE_RUNTIME_NAME = /^tool-device_[a-z0-9]{1,6}__(.+)$/u;

/**
 * The tool behind a device tool part (one that runs on the user's own computer
 * through the desktop shell), or `null` for any other tool. The backend stamps
 * the device's name as the call's "server" once the run is saved
 * (`callProviderMetadata.neore`), and the real tool name with it; until then the
 * runtime name gives the tool, and the app reads the device's name live.
 */
export const resolveDeviceToolName = (part: Pick<ToolPart, "callProviderMetadata" | "type">): DeviceToolName | null => {
    const match = DEVICE_RUNTIME_NAME.exec(part.type);

    if (!match?.[1]) {
        return null;
    }

    const label = part.callProviderMetadata?.neore;

    if (typeof label?.mcpServerName === "string" && typeof label.mcpToolName === "string") {
        return { deviceName: label.mcpServerName, toolName: label.mcpToolName };
    }

    return { toolName: match[1] };
};
