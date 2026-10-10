import { describe, expect, it } from "vitest";

import { requestBearer, requestWsTicket } from "./request-bearer";

const upgrade = (url: string, headers: Record<string, string> = {}): Request => new Request(url, { headers: { Upgrade: "websocket", ...headers } });

describe(requestBearer, () => {
    it("reads the Authorization header", () => {
        expect(requestBearer(new Request("http://x/_lunora/rpc", { headers: { Authorization: "Bearer jwt" } }))).toBe("jwt");
    });

    it("never reads a bearer from the URL, not even on the socket upgrade", () => {
        expect(requestBearer(upgrade("http://x/_lunora/ws?token=jwt"))).toBeUndefined();
        expect(requestBearer(new Request("http://x/_lunora/rpc?token=jwt"))).toBeUndefined();
    });

    it("treats an empty bearer as none", () => {
        expect(requestBearer(new Request("http://x/_lunora/rpc", { headers: { Authorization: "Bearer " } }))).toBeUndefined();
    });
});

describe(requestWsTicket, () => {
    it("reads the ticket on a WebSocket upgrade to the socket path", () => {
        expect(requestWsTicket(upgrade("http://x/_lunora/ws?token=ticket"))).toBe("ticket");
    });

    it("ignores it on a plain request", () => {
        expect(requestWsTicket(new Request("http://x/_lunora/ws?token=ticket"))).toBeUndefined();
        expect(requestWsTicket(new Request("http://x/_lunora/rpc?token=ticket"))).toBeUndefined();
    });

    it("ignores it on an upgrade to any other path", () => {
        expect(requestWsTicket(upgrade("http://x/_lunora/voice/agent?token=ticket"))).toBeUndefined();
    });

    it("treats an empty ticket as none", () => {
        expect(requestWsTicket(upgrade("http://x/_lunora/ws?token="))).toBeUndefined();
    });
});
