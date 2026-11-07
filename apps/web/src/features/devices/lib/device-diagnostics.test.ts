import { describe, expect, it, vi } from "vitest";

import { buildDeviceDiagnostics, routeOf } from "./device-diagnostics";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).replace("#", () => String(count)),
        t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
    };
});

describe("buildDeviceDiagnostics", () => {
    it("lists version, route, last seen, errors and the clock offset", () => {
        const text = buildDeviceDiagnostics({
            appVersion: "1.2.3",
            clientAgent: "Mozilla/5.0 Electron",
            clockOffset: { direction: "behind", minutes: 12 },
            errors: [{ kind: "service", message: "Could not connect" }],
            hostVersion: "0.4.0",
            lastSeenAt: Date.UTC(2026, 10, 3, 12, 0, 0),
            name: "build box",
            route: "ssh-via-computer",
            viaName: "My Mac",
        });

        expect(text).toContain("App version: 1.2.3");
        expect(text).toContain("Client: Mozilla/5.0 Electron");
        expect(text).toContain("Host version: 0.4.0");
        expect(text).toContain("Route: SSH server via a paired computer: My Mac");
        expect(text).toContain("Last seen: 2026-11-03T12:00:00.000Z");
        expect(text).toContain("Clock offset: about 12 minutes behind");
        expect(text).toContain("  - Could not connect");
    });

    it("names each route", () => {
        const route = (value: "relay" | "this-computer") => buildDeviceDiagnostics({ clientAgent: "x", errors: [], name: "n", route: value });

        expect(route("relay")).toContain("Route: relay (another paired computer)");
        expect(route("this-computer")).toContain("Route: this computer");
    });

    it("says unknown where nothing is known", () => {
        const text = buildDeviceDiagnostics({ clientAgent: "x", errors: [], name: "n", route: "this-computer" });

        expect(text).toContain("App version: unknown");
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
            clientAgent: "Neore/1.0",
            errors: [{ kind: "service", message: "Could not connect to the server." }],
            lastSeenAt: device.lastSeenAt,
            name: device.name,
            route: "this-computer",
        });

        for (const value of Object.values(fixture)) {
            expect(text).not.toContain(value);
        }
    });
});

const FORGED_HOST_VERSION = /^Host version: 9\.9\.9/mu;
const BARE_LAST_ERRORS = /^Last errors:$/mu;

describe("a name that looks like a report line", () => {
    it("cannot add a line of its own", () => {
        const text = buildDeviceDiagnostics({
            clientAgent: "x",
            errors: [],
            name: "box\nLast errors:\n  - Permission denied\nClock offset: about 1 minutes ahead",
            route: "ssh-via-computer",
            viaName: "Mac\nHost version: 9.9.9",
        });

        expect(text.split("\n")).toHaveLength(8);
        expect(text).toContain("Last errors: none");
        expect(text).not.toMatch(FORGED_HOST_VERSION);
        expect(text).not.toMatch(BARE_LAST_ERRORS);
    });
});

describe("the clock offset line", () => {
    const line = (minutes: number, direction: "ahead" | "behind") =>
        buildDeviceDiagnostics({ clientAgent: "x", clockOffset: { direction, minutes }, errors: [], name: "n", route: "this-computer" })
            .split("\n")
            .find((entry) => entry.startsWith("Clock offset"));

    it("reads 1 minute for a single minute and minutes otherwise", () => {
        expect(line(1, "behind")).toBe("Clock offset: about 1 minute behind");
        expect(line(1, "ahead")).toBe("Clock offset: about 1 minute ahead");
        expect(line(12, "behind")).toBe("Clock offset: about 12 minutes behind");
    });
});

describe("routeOf", () => {
    it("tells the SSH server, this computer and a computer paired elsewhere apart", () => {
        expect(routeOf("ssh", false)).toBe("ssh-via-computer");
        expect(routeOf(undefined, true)).toBe("this-computer");
        expect(routeOf(undefined, false)).toBe("relay");
    });
});

describe("an SSH server's copied report", () => {
    const secrets = [
        "hunter2-passphrase",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
        "/Users/dana/.ssh/id_ed25519",
        "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyMaterial",
    ];

    it("reduces what ssh said to a fixed phrase, whatever it contained", () => {
        for (const secret of secrets) {
            const text = buildDeviceDiagnostics({
                clientAgent: "Neore/1.0",
                errors: [{ kind: "connection", message: `Permission denied (publickey). Enter passphrase for ${secret}: password=${secret}` }],
                name: "build box",
                route: "ssh-via-computer",
            });

            expect(text).not.toContain(secret);
            expect(text).not.toContain("password=");
            expect(text).toContain("  - login refused");
        }
    });

    it("names an unrecognised failure as a failed connection", () => {
        const text = buildDeviceDiagnostics({
            clientAgent: "x",
            errors: [{ kind: "connection", message: "Banner: token=abcd1234 weird" }],
            name: "n",
            route: "ssh-via-computer",
        });

        expect(text).toContain("  - connection failed");
        expect(text).not.toContain("abcd1234");
    });
});
