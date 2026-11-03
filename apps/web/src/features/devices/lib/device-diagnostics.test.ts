import { describe, expect, it } from "vitest";

import { buildDeviceDiagnostics, routeOf, withReconnectReason } from "./device-diagnostics";

describe("buildDeviceDiagnostics", () => {
    it("lists version, route, last seen, errors and the clock offset", () => {
        const text = buildDeviceDiagnostics({
            appVersion: "Neore/1.2.3",
            clockOffset: "about 12 minutes behind",
            errors: ["Could not connect"],
            hostVersion: "0.4.0",
            lastSeenAt: Date.UTC(2026, 10, 3, 12, 0, 0),
            name: "build box",
            route: "ssh-via-computer",
            viaName: "My Mac",
        });

        expect(text).toContain("App: Neore/1.2.3");
        expect(text).toContain("Host version: 0.4.0");
        expect(text).toContain("Route: SSH server via a paired computer (My Mac)");
        expect(text).toContain("Last seen: 2026-11-03T12:00:00.000Z");
        expect(text).toContain("Clock offset: about 12 minutes behind");
        expect(text).toContain("  - Could not connect");
    });

    it("names each route", () => {
        const route = (value: "relay" | "this-computer") => buildDeviceDiagnostics({ appVersion: "x", errors: [], name: "n", route: value });

        expect(route("relay")).toContain("Route: relay (another paired computer)");
        expect(route("this-computer")).toContain("Route: this computer");
    });

    it("says unknown where nothing is known", () => {
        const text = buildDeviceDiagnostics({ appVersion: "x", errors: [], name: "n", route: "this-computer" });

        expect(text).toContain("Host version: unknown");
        expect(text).toContain("Last seen: never");
        expect(text).toContain("Clock offset: unknown");
        expect(text).toContain("Last errors: none");
    });

    it("never carries a secret that is not one of its inputs", () => {
        const fixture = {
            deviceSecret: "0123456789abcdef".repeat(4),
            envelope: '{"v":1,"kind":"call","deviceId":"abc"}',
            pairingSecret: "pair-secret-xyz",
            signature: "1b5fba44e5ec8d6a71b4b7d5b471382b89ca9b147ab0cf28976e9e7756a73ef6",
            token: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        };
        // A caller hands over a whole device object; only the named fields may be passed on.
        const device = { ...fixture, lastSeenAt: 1, name: "box" };
        const text = buildDeviceDiagnostics({
            appVersion: "Neore/1.0",
            errors: ["Could not connect to the server."],
            lastSeenAt: device.lastSeenAt,
            name: device.name,
            route: "this-computer",
        });

        for (const value of Object.values(fixture)) {
            expect(text).not.toContain(value);
        }
    });
});

describe("routeOf", () => {
    it("tells the SSH server, this computer and a computer paired elsewhere apart", () => {
        expect(routeOf("ssh", false)).toBe("ssh-via-computer");
        expect(routeOf(undefined, true)).toBe("this-computer");
        expect(routeOf(undefined, false)).toBe("relay");
    });
});

describe("withReconnectReason", () => {
    it("puts the current reconnect reason after the remembered errors", () => {
        const rows = withReconnectReason([{ message: "Older manifest failure" }], "Host went away");

        expect(rows.map((row) => row.message)).toEqual(["Older manifest failure", "Host went away"]);
        expect(rows.at(-1)?.message).toBe("Host went away");
        expect(withReconnectReason([{ message: "a" }], undefined)).toEqual([{ message: "a" }]);
    });
});
