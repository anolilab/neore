import { describe, expect, it } from "vitest";

import { resolveDeviceToolName } from "./device-tool-name";

describe("resolveDeviceToolName", () => {
    it("reads the tool from the runtime name while the call streams", () => {
        expect(resolveDeviceToolName({ type: "tool-device_a1b2c3__shell_run" })).toEqual({ toolName: "shell_run" });
        expect(resolveDeviceToolName({ type: "tool-device_a1b2c3__mcp__git__status" })).toEqual({ toolName: "mcp__git__status" });
    });

    it("prefers the device and tool the backend stamped", () => {
        expect(
            resolveDeviceToolName({
                callProviderMetadata: { neore: { mcpServerName: "Work laptop", mcpToolName: "fs_read" } },
                type: "tool-device_a1b2c3__fs_read_2",
            }),
        ).toEqual({ deviceName: "Work laptop", toolName: "fs_read" });
    });

    it("is null for every other tool", () => {
        expect(resolveDeviceToolName({ type: "tool-mcp_git__status" })).toBeNull();
        expect(resolveDeviceToolName({ type: "tool-webSearch" })).toBeNull();
        expect(resolveDeviceToolName({ type: "tool-device__x" })).toBeNull();
    });
});
