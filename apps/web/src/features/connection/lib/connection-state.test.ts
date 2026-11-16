import { describe, expect, it } from "vitest";

import {
    bannerDelayMs,
    CONNECTION_THRESHOLDS_MS,
    connectionPresentationOf,
    connectionViewOf,
    initialConnectionState,
    reduceConnection,
    screenDelayMs,
} from "./connection-state";

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

    it("stays reconnecting between attempts at a backend that has never answered, instead of flickering online", () => {
        let state = reduceConnection(start, { status: "offline", type: "live" });

        state = reduceConnection(state, { status: "connecting", type: "live" });

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

describe("connectionPresentationOf", () => {
    it("shows nothing while online", () => {
        expect(connectionPresentationOf("online", "screen")).toEqual({ backOnline: false, banner: "online", screen: null, view: "online" });
    });

    it("on an offline start, shows the banner and the offline screen at once", () => {
        expect(screenDelayMs("offline", false)).toBe(0);
        expect(connectionPresentationOf("offline", "pending", { hasConnected: false })).toEqual({
            backOnline: false,
            banner: "offline",
            screen: "offline",
            view: "offline",
        });
    });

    it("once connected, shows the offline banner at once and the screen only after the offline threshold", () => {
        expect(bannerDelayMs("offline", true)).toBe(0);
        expect(screenDelayMs("offline", true)).toBe(CONNECTION_THRESHOLDS_MS.offlineScreen);
        expect(connectionPresentationOf("offline", "pending")).toMatchObject({ banner: "offline", screen: null });
        expect(connectionPresentationOf("offline", "screen")).toMatchObject({ banner: "offline", screen: "offline" });
    });

    it("holds a reconnect back for the grace period, then counts the screen threshold from the banner", () => {
        expect(bannerDelayMs("reconnecting", true)).toBe(CONNECTION_THRESHOLDS_MS.reconnectingBanner);
        expect(screenDelayMs("reconnecting", true)).toBe(CONNECTION_THRESHOLDS_MS.reconnectingBanner + CONNECTION_THRESHOLDS_MS.reconnectingScreen);
        expect(connectionPresentationOf("reconnecting", "pending").banner).toBe("online");
        expect(connectionPresentationOf("reconnecting", "banner")).toMatchObject({ banner: "reconnecting", screen: null });
        expect(connectionPresentationOf("reconnecting", "screen")).toMatchObject({ banner: "reconnecting", screen: "reconnecting" });
    });

    it("shows a backend that never answered on this page load at once, with no bounce to wait out", () => {
        expect(bannerDelayMs("reconnecting", false)).toBe(0);
        expect(connectionPresentationOf("reconnecting", "pending", { hasConnected: false }).banner).toBe("reconnecting");
    });
});
