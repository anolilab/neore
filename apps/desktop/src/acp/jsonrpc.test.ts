import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "./jsonrpc";

const frame = (method: string): string => `${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`;

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
