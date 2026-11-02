import { describe, expect, it } from "vitest";

import type { PermissionRequestEvent } from "./host-events";
import { capPermissionRequest, capSessionInfo } from "./host-events";

describe("capSessionInfo", () => {
    const info = (nativeSessionId: string) => capSessionInfo({ agentKey: "claude", agentLabel: "Claude", folderId: "f", folderLabel: "d", nativeSessionId });

    it("keeps an agent session id of 256 UTF-8 bytes, which is what the core accepts", () => {
        const id = "é".repeat(128);

        expect(info(id).nativeSessionId).toBe(id);
    });

    it("drops one longer in bytes even when short in characters, rather than cutting it into another id", () => {
        expect(info("é".repeat(129))).not.toHaveProperty("nativeSessionId");
        expect(info("x".repeat(257))).not.toHaveProperty("nativeSessionId");
    });
});

const request = (fields: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent => {
    return {
        kind: "permission_request",
        options: [{ kind: "allow_once", name: "Allow", optionId: "a" }],
        requestId: "r1",
        tool: "Run tests",
        ...fields,
    };
};

describe("capPermissionRequest", () => {
    it("sends a request that fits as complete", () => {
        expect(capPermissionRequest(request({ command: "pnpm test", target: "src/a.ts" }))).toMatchObject({ command: "pnpm test", complete: true, target: "src/a.ts" });
    });

    it("says so when the command or the target had to be cut, so a remote allow is never offered for it", () => {
        const longCommand = capPermissionRequest(request({ command: "x".repeat(10_001) }));
        const longTarget = capPermissionRequest(request({ target: "y".repeat(2001) }));

        expect(longCommand.complete).toBe(false);
        expect(longCommand.command).toHaveLength(10_000);
        expect(longTarget.complete).toBe(false);
        expect(longTarget.target).toHaveLength(2000);
    });

    it("keeps a request incomplete that the session already found incomplete", () => {
        expect(capPermissionRequest(request({ command: "ls", complete: false })).complete).toBe(false);
    });
});
