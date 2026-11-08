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
        expect(category("could not connect to dana@box: the server did not answer in time")).toBe("timed out");
        expect(category("neore-host 0.4.0 is not installed on deploy@authentication.corp.example:22. Install it from the server's settings.")).toBe(
            "the host software is not installed",
        );
        expect(category("could not connect to dana@box:22: the host speaks protocol 3 and this app speaks 4")).toBe(
            "the host software does not match this app",
        );
        expect(category("neore-host on dana@box did not understand how it was started: the software there is out of date.")).toBe(
            "the host software is out of date",
        );
        expect(category("connect to host box port 22: Connection refused")).toBe("server not reachable");
        expect(category("Banner: token=abcd1234 weird")).toBe("connection failed");
        expect(category("the passphrase channel failed: Permission denied (os error 13)")).toBe("connection failed");
        expect(category("the host key could not be saved: Permission denied (os error 13)")).toBe("connection failed");
        expect(category("could not connect to dana@timeout.example:22: ssh: connect to host timeout.example port 22: Connection refused")).toBe(
            "server not reachable",
        );
        expect(category("Reset box's host software is being upgraded; connect again in a moment")).toBe("the host software is being upgraded");
        expect(category("dana@box:22 presented no host key (is it reachable, and is it running an SSH server?) (gave up after 5 attempts)")).toBe(
            "server not reachable",
        );
        expect(category("Unable to negotiate with offending port 22: no matching host key type found. Their offer: ssh-dss")).toBe(
            "the host key could not be verified",
        );
        expect(category("ssh: connect to host authentication.example port 22: Operation timed out")).toBe("timed out");
        expect(category("the server offered no usable host key")).toBe("the host key could not be verified");
        expect(category("dana@box: Permission denied (publickey,password).")).toBe("login refused");
    });
});

describe("routeOf", () => {
    it("tells the SSH server, this computer and a computer paired elsewhere apart", () => {
        expect(routeOf("ssh", false)).toBe("ssh-via-computer");
        expect(routeOf(undefined, true)).toBe("this-computer");
        expect(routeOf(undefined, false)).toBe("relay");
    });
});
