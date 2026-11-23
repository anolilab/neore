import { requestWsTicket } from "@neore/backend/request-bearer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLunoraClient } from "./lunora-client";

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Records each socket's upgrade URL; never opens, so the client just waits. */
const recordSockets = (): string[] => {
    const opened: string[] = [];

    vi.stubGlobal(
        "WebSocket",
        class extends EventTarget {
            public readyState = 0;

            public constructor(url: string | URL) {
                super();
                opened.push(String(url));
            }

            public close(): void {
                this.readyState = 3;
            }

            public send(): void {
                // Never opened, as a real socket still connecting: sending throws.
                if (this.readyState !== 1) {
                    throw new DOMException("Still connecting", "InvalidStateError");
                }
            }
        },
    );

    return opened;
};

describe("createLunoraClient", () => {
    it("opens the live-query socket with a ticket the server's upgrade check redeems, minted without cookies", async () => {
        const opened = recordSockets();
        const fetchMock = vi.fn<typeof fetch>(async (input) => Response.json(String(input).endsWith("/_lunora/ws-ticket") ? { ticket: "t1" } : {}));

        vi.stubGlobal("fetch", fetchMock);

        const client = createLunoraClient("https://api.example.test");

        client.setAuthToken("h.eyJzdWIiOiJ1MSJ9.s");

        const unsubscribe = client.subscribe({ __lunoraRef: "chat:list" } as never, {} as never, () => undefined);

        await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
        unsubscribe();
        client.close();

        // What the Worker reads off the upgrade (`backend/src/server.ts#resolveCallerIdentity`).
        const upgrade = new Request(opened[0]?.replace(/^ws/u, "http") ?? "", { headers: { Upgrade: "websocket" } });

        expect(requestWsTicket(upgrade)).toBe("t1");

        const [, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/_lunora/ws-ticket")) ?? [];

        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer h.eyJzdWIiOiJ1MSJ9.s");
    });
});
