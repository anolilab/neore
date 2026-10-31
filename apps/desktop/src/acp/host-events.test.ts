import { describe, expect, it } from "vitest";

import type { PermissionRequestEvent } from "./host-events";
import { capPermissionRequest } from "./host-events";

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
