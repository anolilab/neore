import { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import type { LiveSocketClient } from "./live-socket";
import { wireLiveSocket } from "./live-socket";

const jwt = (subject: string): string => `h.${btoa(JSON.stringify({ sub: subject })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.s`;

const fakeClient = (initial: string | null) => {
    let token = initial;
    const listeners: ((next: string | null) => void)[] = [];
    const setWsTicket = vi.fn();
    const client: LiveSocketClient = {
        getAuthToken: () => token,
        onAuthTokenChange: (listener) => {
            listeners.push(listener);

            return () => undefined;
        },
        setWsTicket,
    };

    return {
        change: (next: string | null) => {
            token = next;

            for (const listener of listeners) {
                listener(next);
            }
        },
        client,
        setWsTicket,
    };
};

describe("wireLiveSocket", () => {
    it("gives the socket a provider that mints a ticket for the current bearer", async () => {
        const fake = fakeClient(jwt("u1"));
        const mint = vi.fn(async (_bearer: string) => "ticket-1");

        wireLiveSocket(fake.client, mint);

        const provider = fake.setWsTicket.mock.calls[0]?.[0] as () => Promise<string | undefined>;

        await expect(provider()).resolves.toBe("ticket-1");
        expect(mint).toHaveBeenCalledWith(jwt("u1"));
    });

    it("opens the socket anonymously when there is no bearer", async () => {
        const fake = fakeClient(null);
        const mint = vi.fn(async (_bearer: string) => "ticket");

        wireLiveSocket(fake.client, mint);

        const provider = fake.setWsTicket.mock.calls[0]?.[0] as () => Promise<string | undefined>;

        await expect(provider()).resolves.toBeUndefined();
        expect(mint).not.toHaveBeenCalled();
    });

    it("keeps the socket across a refresh of the same user's token and reconnects it for another user", () => {
        const fake = fakeClient(jwt("u1"));

        wireLiveSocket(fake.client, vi.fn());
        expect(fake.setWsTicket).toHaveBeenCalledTimes(1);

        fake.change(jwt("u1"));
        expect(fake.setWsTicket).toHaveBeenCalledTimes(1);

        fake.change(jwt("u2"));
        expect(fake.setWsTicket).toHaveBeenCalledTimes(2);
        expect(fake.setWsTicket.mock.calls[1]?.[0]).not.toBe(fake.setWsTicket.mock.calls[0]?.[0]);

        fake.change(null);
        expect(fake.setWsTicket).toHaveBeenCalledTimes(3);
    });

    it("puts the ticket on the socket's upgrade URL, where the backend redeems it", async () => {
        const opened: string[] = [];

        // Records each upgrade URL; never opens, so the client just waits.
        class RecordingSocket extends EventTarget {
            public readyState = 0;

            public constructor(url: string | URL) {
                super();
                opened.push(String(url));
            }

            public close(): void {}

            public send(): void {}
        }

        const client = new LunoraClient({
            fetch: async () => Response.json({}),
            url: "https://api.example.test",
            WebSocket: RecordingSocket as unknown as typeof WebSocket,
        });

        client.setAuthToken(jwt("u1"));
        wireLiveSocket(client, async () => "ticket-1");

        const unsubscribe = client.subscribe({ __lunoraRef: "chat:list" } as never, {} as never, () => undefined);

        await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
        unsubscribe();
        client.close();

        expect(new URL(opened[0] ?? "").searchParams.get("token")).toBe("ticket-1");
    });
});
