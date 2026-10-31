import { describe, expect, it, vi } from "vitest";

import type { LiveSocketClient } from "./live-socket";
import { wireLiveSocket } from "./live-socket";

const jwt = (subject: string): string => `h.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.s`;

const fakeClient = (initial: string | null) => {
    let token = initial;
    const listeners: ((next: string | null) => void)[] = [];
    const setWsToken = vi.fn();
    const client: LiveSocketClient = {
        getAuthToken: () => token,
        onAuthTokenChange: (listener) => {
            listeners.push(listener);

            return () => undefined;
        },
        setWsToken,
    };

    return {
        change: (next: string | null) => {
            token = next;

            for (const listener of listeners) {
                listener(next);
            }
        },
        client,
        setWsToken,
    };
};

describe("wireLiveSocket", () => {
    it("gives the socket a provider that mints a ticket for the current bearer", async () => {
        const fake = fakeClient(jwt("u1"));
        const mint = vi.fn(async (_bearer: string) => "ticket-1");

        wireLiveSocket(fake.client, mint);

        const provider = fake.setWsToken.mock.calls[0]?.[0] as () => Promise<string | undefined>;

        await expect(provider()).resolves.toBe("ticket-1");
        expect(mint).toHaveBeenCalledWith(jwt("u1"));
    });

    it("opens the socket anonymously when there is no bearer", async () => {
        const fake = fakeClient(null);
        const mint = vi.fn(async (_bearer: string) => "ticket");

        wireLiveSocket(fake.client, mint);

        const provider = fake.setWsToken.mock.calls[0]?.[0] as () => Promise<string | undefined>;

        await expect(provider()).resolves.toBeUndefined();
        expect(mint).not.toHaveBeenCalled();
    });

    it("keeps the socket across a refresh of the same user's token and reconnects it for another user", () => {
        const fake = fakeClient(jwt("u1"));

        wireLiveSocket(fake.client, vi.fn());
        expect(fake.setWsToken).toHaveBeenCalledTimes(1);

        fake.change(jwt("u1"));
        expect(fake.setWsToken).toHaveBeenCalledTimes(1);

        fake.change(jwt("u2"));
        expect(fake.setWsToken).toHaveBeenCalledTimes(2);
        expect(fake.setWsToken.mock.calls[1]?.[0]).not.toBe(fake.setWsToken.mock.calls[0]?.[0]);

        fake.change(null);
        expect(fake.setWsToken).toHaveBeenCalledTimes(3);
    });
});
