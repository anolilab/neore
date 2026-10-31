import { describe, expect, it } from "vitest";

import { INITIAL_CONNECTIVITY, isNetworkFailure, isOffline, reduceConnectivity } from "./connectivity";

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

describe("isNetworkFailure", () => {
    it("treats a failed fetch as a network failure and a server answer as not", () => {
        expect(isNetworkFailure(new TypeError("Network request failed"))).toBe(true);
        expect(isNetworkFailure(new Error("Thread not found"))).toBe(false);
        expect(isNetworkFailure("boom")).toBe(false);
    });
});
