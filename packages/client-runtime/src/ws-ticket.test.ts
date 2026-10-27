import { describe, expect, it, vi } from "vitest";

import { createWsTicketMinter, WS_TICKET_PATH } from "./ws-ticket";

const respond = (body: unknown, status = 200) => vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json(body, { status }));

describe(createWsTicketMinter, () => {
    it("POSTs the bearer in a header, never in the URL, and returns the ticket", async () => {
        const fetchImpl = respond({ ticket: "t1" });

        await expect(createWsTicketMinter("https://api.example", fetchImpl)("jwt")).resolves.toBe("t1");

        const [url, init] = fetchImpl.mock.calls[0]!;

        expect(String(url)).toBe(`https://api.example${WS_TICKET_PATH}`);
        expect(init).toMatchObject({ headers: { Authorization: "Bearer jwt" }, method: "POST" });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("answers undefined on 401, so the socket opens anonymously", async () => {
        await expect(createWsTicketMinter("https://api.example", respond({}, 401))("stale")).resolves.toBeUndefined();
    });

    it("throws on any other failure, so the client retries", async () => {
        await expect(createWsTicketMinter("https://api.example", respond({}, 503))("jwt")).rejects.toThrow("503");
        await expect(createWsTicketMinter("https://api.example", respond({}))("jwt")).rejects.toThrow("no ticket");
    });
});
