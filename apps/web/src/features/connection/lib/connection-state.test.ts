import { describe, expect, it } from "vitest";

import { connectionViewOf, initialConnectionState, reduceConnection } from "./connection-state";

const start = initialConnectionState(true);

describe("connectionViewOf", () => {
    it("is online on first paint, before any socket has opened", () => {
        expect(connectionViewOf(start)).toBe("online");
    });

    it("ignores connecting until a socket has been open", () => {
        const connecting = reduceConnection(start, { status: "connecting", type: "live" });

        expect(connectionViewOf(connecting)).toBe("online");
    });

    it("reconnects once a socket has been open and drops again", () => {
        let state = reduceConnection(start, { status: "connected", type: "live" });

        state = reduceConnection(state, { status: "connecting", type: "live" });

        expect(connectionViewOf(state)).toBe("reconnecting");
    });

    it("reconnects when the backend goes down after a connection, with the browser online", () => {
        let state = reduceConnection(start, { status: "connected", type: "live" });

        state = reduceConnection(state, { status: "offline", type: "live" });

        expect(state.browserOnline).toBe(true);
        expect(connectionViewOf(state)).toBe("reconnecting");
    });

    it("treats a backend that never answered as reconnecting", () => {
        const state = reduceConnection(start, { status: "offline", type: "live" });

        expect(connectionViewOf(state)).toBe("reconnecting");
    });

    it("reports offline whenever the browser is offline, whatever the socket says", () => {
        const offline = reduceConnection(start, { online: false, type: "browser" });

        expect(connectionViewOf(offline)).toBe("offline");
        expect(connectionViewOf(reduceConnection(offline, { status: "connected", type: "live" }))).toBe("offline");
    });

    it("clears back to online when the browser returns and the socket is up", () => {
        let state = reduceConnection(start, { status: "connected", type: "live" });

        state = reduceConnection(state, { online: false, type: "browser" });
        state = reduceConnection(state, { online: true, type: "browser" });

        expect(connectionViewOf(state)).toBe("online");
    });

    it("treats idle and polling as online, because data still arrives", () => {
        expect(connectionViewOf(reduceConnection(start, { status: "idle", type: "live" }))).toBe("online");
        expect(connectionViewOf(reduceConnection(start, { status: "polling", type: "live" }))).toBe("online");
    });
});

describe("reduceConnection", () => {
    it("latches hasConnected so a later connecting is a reconnect", () => {
        let state = reduceConnection(start, { status: "connected", type: "live" });

        state = reduceConnection(state, { status: "idle", type: "live" });

        expect(state.hasConnected).toBe(true);
    });
});
