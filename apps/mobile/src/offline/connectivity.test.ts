import { LunoraClient, TransportError } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { canWrite, INITIAL_CONNECTIVITY, isNetworkFailure, isOffline, isReachable, reduceConnectivity } from "./connectivity";

describe("isOffline", () => {
    it("is online until something says otherwise", () => {
        expect(isOffline(INITIAL_CONNECTIVITY)).toBe(false);
    });

    it("is offline when the device has no network", () => {
        expect(isOffline(reduceConnectivity(INITIAL_CONNECTIVITY, { network: false, type: "network" }))).toBe(true);
    });

    it("is offline when the live socket is down", () => {
        expect(isOffline(reduceConnectivity(INITIAL_CONNECTIVITY, { socket: "offline", type: "socket" }))).toBe(true);
    });

    it("is not offline while the socket is idle, connecting or polling", () => {
        for (const socket of ["idle", "connecting", "polling", "connected"] as const) {
            expect(isOffline(reduceConnectivity(INITIAL_CONNECTIVITY, { socket, type: "socket" })), socket).toBe(false);
        }
    });

    it("is offline after a request failed on the network, until one succeeds", () => {
        const failed = reduceConnectivity(INITIAL_CONNECTIVITY, { type: "request-failed" });

        expect(isOffline(failed)).toBe(true);
        expect(isOffline(reduceConnectivity(failed, { type: "request-succeeded" }))).toBe(false);
    });

    it("forgets a failed request when the network comes back, so the next refresh decides", () => {
        let state = reduceConnectivity(INITIAL_CONNECTIVITY, { network: false, type: "network" });

        state = reduceConnectivity(state, { type: "request-failed" });
        state = reduceConnectivity(state, { network: true, type: "network" });

        expect(isOffline(state)).toBe(false);
    });
});

describe("a signed-in launch without a token", () => {
    it("is offline: the server could not be reached to mint one", () => {
        const state = reduceConnectivity(INITIAL_CONNECTIVITY, { missing: true, type: "token" });

        expect(isOffline(state)).toBe(true);
        expect(isOffline(reduceConnectivity(state, { missing: false, type: "token" }))).toBe(false);
    });
});

describe("a successful request", () => {
    it("overrides a network hint that said there was no network", () => {
        let state = reduceConnectivity(INITIAL_CONNECTIVITY, { network: false, type: "network" });

        state = reduceConnectivity(state, { type: "request-succeeded" });

        expect(state.network).toBe(true);
        expect(isOffline(state)).toBe(false);
    });
});

describe("isReachable", () => {
    it("goes by isConnected: an unconfirmed internet flag does not mean offline", () => {
        expect(isReachable({ isConnected: true, isInternetReachable: false })).toBe(true);
        expect(isReachable({ isConnected: true, isInternetReachable: undefined })).toBe(true);
        expect(isReachable({ isConnected: false, isInternetReachable: true })).toBe(false);
    });

    it("does not call an unknown connection offline", () => {
        expect(isReachable({})).toBe(true);
    });
});

describe("canWrite", () => {
    it("stays false after the network returns until a request has worked", () => {
        let state = reduceConnectivity(INITIAL_CONNECTIVITY, { network: false, type: "network" });

        expect(canWrite(state)).toBe(false);

        state = reduceConnectivity(state, { network: true, type: "network" });

        expect(isOffline(state)).toBe(false);
        expect(canWrite(state)).toBe(false);

        state = reduceConnectivity(state, { type: "request-succeeded" });

        expect(canWrite(state)).toBe(true);
    });

    it("stays false after a failed request whose network event then arrives", () => {
        let state = reduceConnectivity(INITIAL_CONNECTIVITY, { type: "request-failed" });

        state = reduceConnectivity(state, { network: true, type: "network" });

        expect(canWrite(state)).toBe(false);
    });

    it("is true on a launch that has had no trouble", () => {
        expect(canWrite(INITIAL_CONNECTIVITY)).toBe(true);
        expect(canWrite(reduceConnectivity(INITIAL_CONNECTIVITY, { network: true, type: "network" }))).toBe(true);
    });
});

describe("isNetworkFailure against a real client", () => {
    const readThrough = async (fetchImpl: typeof fetch, rpcTimeoutMs?: number): Promise<unknown> => {
        const client = new LunoraClient({ fetch: fetchImpl, rpcTimeoutMs, url: "http://localhost:1" });

        try {
            await client.query({ __lunoraRef: "chat:list" } as never, {} as never);
        } catch (error) {
            return error;
        } finally {
            await client.close();
        }

        return undefined;
    };

    it("sees a rejected fetch (a dead server) as a network failure", async () => {
        const error = await readThrough(async () => {
            throw new TypeError("Network request failed");
        });

        expect(isNetworkFailure(error)).toBe(true);
    });

    it("sees a request that never answers, cut by the client's timeout, as a network failure", async () => {
        const error = await readThrough(() => new Promise<Response>(() => {
            // Never settles: the server accepted the connection and went quiet.
        }), 20);

        expect(isNetworkFailure(error)).toBe(true);
    });

    it("sees a bare gateway error page as a network failure and a server verdict as not", async () => {
        const gateway = await readThrough(async () => new Response("<html>bad gateway</html>", { status: 502 }));
        const refused = await readThrough(
            async () => Response.json({ error: { code: "FORBIDDEN", message: "This chat is locked." } }, { status: 403 }),
        );

        expect(isNetworkFailure(gateway)).toBe(true);
        expect(isNetworkFailure(refused)).toBe(false);
    });
});

describe("isNetworkFailure", () => {
    it("treats the errors a failed fetch throws as network failures", () => {
        for (const message of ["Network request failed", "Network request timed out", "Failed to fetch", "fetch failed", "Load failed"]) {
            expect(isNetworkFailure(new TypeError(message)), message).toBe(true);
        }

        expect(isNetworkFailure(new TransportError("no envelope"))).toBe(true);
    });

    it("does not call a bug or a server answer a network failure", () => {
        expect(isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'page')"))).toBe(false);
        expect(isNetworkFailure(new TypeError("undefined is not a function"))).toBe(false);
        expect(isNetworkFailure(new Error("Thread not found"))).toBe(false);
        expect(isNetworkFailure("boom")).toBe(false);
    });
});
