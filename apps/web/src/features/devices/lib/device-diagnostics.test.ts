import { describe, expect, it, vi } from "vitest";

import { buildDeviceDiagnostics, connectionFailureCategory, routeOf } from "./device-diagnostics";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted): a descriptor is its rendered English.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            return { id: String.raw({ raw: strings }, ...values) };
        },
    };
});

const i18n = { _: (descriptor: { id: string }) => descriptor.id } as never;

describe("buildDeviceDiagnostics", () => {
    it("lists the connection, client, route, last seen and the failure's category", () => {
        const text = buildDeviceDiagnostics(
            {
                clientAgent: "Mozilla/5.0 Electron",
                failure: "ssh: connect to host box port 22: Connection timed out",
                lastSeenAt: Date.UTC(2026, 10, 3, 12, 0, 0),
                name: "build box",
                route: "ssh-via-computer",
                viaName: "My Mac",
            },
            i18n,
        );

        expect(text.split("\n")).toEqual([
            "Connection: build box",
            "Client: Mozilla/5.0 Electron",
            "Route: SSH server via a paired computer: My Mac",
            "Last seen: 2026-11-03T12:00:00.000Z",
            "Last failure: timed out",
        ]);
    });

    it("names each route, and says never and none where nothing is known", () => {
        const text = (route: "relay" | "this-computer") => buildDeviceDiagnostics({ clientAgent: "x", name: "n", route }, i18n);

        expect(text("relay")).toContain("Route: relay (another paired computer)");
        expect(text("this-computer")).toContain("Route: this computer");
        expect(text("this-computer")).toContain("Last seen: never");
        expect(text("this-computer")).toContain("Last failure: none");
    });

    it("keeps every field on its own line, whatever a name or the client contains", () => {
        const text = buildDeviceDiagnostics(
            { clientAgent: "agent\nLast failure: none", name: "box\nRoute: forged", route: "ssh-via-computer", viaName: "Mac\nLast seen: never" },
            i18n,
        );

        expect(text.split("\n")).toHaveLength(5);
        expect(text.split("\n").filter((line) => line.startsWith("Route:"))).toHaveLength(1);
        expect(text.split("\n").filter((line) => line.startsWith("Last failure:"))).toHaveLength(1);
    });
});

describe("connectionFailureCategory", () => {
    const secrets = [
        "hunter2-passphrase",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
        "/Users/dana/.ssh/id_ed25519",
        "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8",
    ];

    it("reduces what ssh said to a fixed phrase, whatever it contained", () => {
        for (const secret of secrets) {
            const text = buildDeviceDiagnostics(
                {
                    clientAgent: "x",
                    failure: `Permission denied (publickey). Enter passphrase for ${secret}: password=${secret}`,
                    name: "n",
                    route: "ssh-via-computer",
                },
                i18n,
            );

            expect(text).not.toContain(secret);
            expect(text).toContain("Last failure: login refused");
        }
    });

    it("tells a changed host key, an unverified one, a refused login, a timeout and an unreachable server apart", () => {
        const category = (message: string): string => connectionFailureCategory(message, i18n);

        expect(category("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe("the host key changed");
        expect(category("The host key of dana@box changed. Pinned: SHA256:a. Presented now: SHA256:b. Nothing was sent.")).toBe("the host key changed");
        expect(category("Host key verification failed.")).toBe("the host key could not be verified");
        expect(category("the server's host key was not trusted")).toBe("the host key could not be verified");
        expect(category("could not connect to dana@box: dana@box refused the login (publickey)")).toBe("login refused");
        expect(category("could not connect to me@login.example.com: Connection timed out")).toBe("timed out");
        expect(category("Connection closed by authenticating user dana 10.0.0.2 port 22")).toBe("login refused");
        expect(category("connect to host box port 22: Operation timed out")).toBe("timed out");
        expect(category("connect to host box port 22: Connection refused")).toBe("server not reachable");
        expect(category("Banner: token=abcd1234 weird")).toBe("connection failed");
    });
});

describe("routeOf", () => {
    it("tells the SSH server, this computer and a computer paired elsewhere apart", () => {
        expect(routeOf("ssh", false)).toBe("ssh-via-computer");
        expect(routeOf(undefined, true)).toBe("this-computer");
        expect(routeOf(undefined, false)).toBe("relay");
    });
});
