import { describe, expect, it } from "vitest";

import { mcpToolCallBody } from "./mcp-tool-call";

describe("mcpToolCallBody", () => {
    it("names the thread the host passed and keeps what the app sent as an argument", () => {
        const body = JSON.parse(mcpToolCallBody({ arguments: { threadId: "from-the-app" }, serverName: "srv", threadId: "host-thread", toolName: "run" })) as {
            arguments: { threadId: string };
            threadId: string;
        };

        expect(body.threadId).toBe("host-thread");
        expect(body.arguments.threadId).toBe("from-the-app");
    });

    it("names no thread when the host has none", () => {
        expect(JSON.parse(mcpToolCallBody({ serverName: "srv", toolName: "run" }))).not.toHaveProperty("threadId");
    });
});
