import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "./jsonrpc";

const frame = (method: string): string => `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;

describe("an agent whose input is gone", () => {
    it("rejects a pending request with the agent-closed message, and keeps the write error as its cause", async () => {
        const output = new PassThrough();
        const connection = new JsonRpcConnection(new PassThrough(), output, { notification: vi.fn(), request: async () => 1 });
        const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        const pending = connection.request("initialize", {});

        output.emit("error", epipe);

        let error: unknown;

        try {
            await pending;
        } catch (error_) {
            error = error_;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("the agent closed its output");
        expect((error as Error).cause).toBe(epipe);
    });
});

describe("a closed connection", () => {
    it("reads nothing more, so a line that never ends cannot keep growing", () => {
        const input = new PassThrough();
        const notification = vi.fn();
        const connection = new JsonRpcConnection(input, new PassThrough(), { notification, request: async () => 1 });

        input.write(frame("before"));
        connection.close(new Error("done"));
        expect(input.listenerCount("data")).toBe(0);

        input.write(frame("after"));
        input.emit("data", frame("emitted"));
        expect(notification.mock.calls.map(([method]) => method)).toEqual(["before"]);
    });
});
