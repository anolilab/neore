import { describe, expect, it } from "vitest";

import { deviceDiagnostics, redact, serverDiagnostics } from "./diagnostics";
import type { HostView, SettingsView } from "./types";

const HOME = "/Users/ada";
const context = {
    appVersion: "1.2.3",
    arch: "arm64",
    electronVersion: "44.0.0",
    home: HOME,
    now: new Date("2026-11-02T10:00:00Z"),
    osRelease: "27.2.0",
    platform: "darwin",
};

/** Every value here is something that must never reach the clipboard text. */
const SECRETS = [
    "hunter2-passphrase",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-live-abcdefghijklmnopqrstuvwxyz",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    "AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDhA9Zy0Zq3TKxk2",
    "BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA",
    "/Users/ada/.ssh/id_ed25519",
    "/Users/ada/Library/Application Support/Neore/ssh/cm/abc",
    "/Users/ada/secret-project",
    "pairing-secret-value",
];

const host: HostView = {
    acpAgents: [{ args: ["--token", "sk-live-abcdefghijklmnopqrstuvwxyz"], command: "/Users/ada/bin/agent", envNames: ["API_KEY"], install: null, key: "k", label: "Agent" }],
    acpConsents: [{ agentKey: "k", folderId: "f", folderLabel: "secret-project", folderPath: "/Users/ada/secret-project" }],
    address: "build.example.com",
    agentsSupported: true,
    allowShellNetwork: false,
    connected: false,
    deviceId: "dev_123",
    forwardAgent: false,
    identityFile: "/Users/ada/.ssh/id_ed25519",
    multiplexed: true,
    name: "Build box",
    platform: "linux",
    port: 22,
    reconnect: {
        attempt: 2,
        maxAttempts: 5,
        nextAttemptAt: null,
        phase: "gaveUp",
        reason: [
            "ssh: Permission denied (publickey) using /Users/ada/.ssh/id_ed25519",
            "passphrase=hunter2-passphrase",
            "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "secret: pairing-secret-value",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
            "key AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDhA9Zy0Zq3TKxk2",
            "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
            "cm /Users/ada/Library/Application Support/Neore/ssh/cm/abc",
        ].join(" "),
    },
    requireShellSandbox: true,
    roots: ["/Users/ada/secret-project"],
    sandboxDetail: "Landlock unavailable; api_key=sk-live-abcdefghijklmnopqrstuvwxyz",
    user: "ada",
};

const view: SettingsView = {
    accountLabel: "ada@example.com",
    allowRules: ["shell_run:git push --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    allowShellNetwork: false,
    auditPath: "/Users/ada/Library/Application Support/Neore/audit.log",
    dependenciesUnavailable: null,
    hosts: [host],
    mcpServers: [{ args: [], command: "x", env: { API_TOKEN: "sk-live-abcdefghijklmnopqrstuvwxyz" }, name: "m", network: "off" }],
    mcpStatus: [{ name: "m", networkGap: null, note: "", problem: "cannot start in /Users/ada/secret-project", sandboxed: true }],
    paired: true,
    requireShellSandbox: true,
    roots: ["/Users/ada/secret-project"],
    sandboxUnavailable: "no sandbox for /Users/ada/secret-project",
    shellNetwork: "off",
};

const expectClean = (text: string): void => {
    for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
    }

    expect(text).not.toContain("/Users/ada");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("--token");
};

describe("serverDiagnostics", () => {
    it("holds the versions, the route, the last error and the clock, and no secret", () => {
        const text = serverDiagnostics(view, "dev_123", context) ?? "";

        expect(text).toContain("Neore: 1.2.3 (Electron 44.0.0)");
        expect(text).toContain("Route: ada@build.example.com:22");
        expect(text).toContain("Last error: ssh: Permission denied (publickey) using ~/.ssh/id_ed25519");
        expect(text).toContain("Clock: 2026-11-02T10:00:00.000Z");
        expectClean(text);
    });

    it("answers null for a server that is not listed", () => {
        expect(serverDiagnostics(view, "nope", context)).toBeNull();
    });
});

describe("deviceDiagnostics", () => {
    it("describes this computer and its servers, and no secret", () => {
        const text = deviceDiagnostics(view, context);

        expect(text).toContain("Paired: yes");
        expect(text).toContain("Build box: gaveUp, last error:");
        expectClean(text);
    });
});

describe("redact", () => {
    it("shortens the home folder, with a trailing slash too", () => {
        expect(redact("open /home/bob/code failed", "/home/bob/")).toBe("open ~/code failed");
    });

    it("caps a long message", () => {
        expect(redact("word ".repeat(400), HOME).length).toBeLessThanOrEqual(501);
    });
});
