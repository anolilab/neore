import { describe, expect, it } from "vitest";

import { deviceDiagnostics, reasonCategory, redact, sandboxCategory, serverDiagnostics } from "./diagnostics";
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
        expect(text).toContain("Last error: login refused");
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

describe("the last error", () => {
    const withReason = (reason: string): SettingsView => {
        return {
            ...view,
            hosts: [{ ...host, reconnect: { attempt: null, maxAttempts: 5, nextAttemptAt: null, phase: "gaveUp", reason } }],
        };
    };

    it("is a category, so a short unlabelled password never reaches the text", () => {
        const reason = "ssh: Permission denied, please try again. hunter2";

        expect(serverDiagnostics(withReason(reason), "dev_123", context)).not.toContain("hunter2");
        expect(deviceDiagnostics(withReason(reason), context)).not.toContain("hunter2");
        expect(serverDiagnostics(withReason(reason), "dev_123", context)).toContain("Last error: login refused");
    });

    it("names the common causes", () => {
        expect(reasonCategory("The host key of x changed")).toBe("the host key changed");
        expect(reasonCategory("Connection timed out")).toBe("timed out");
        expect(reasonCategory("Connection refused")).toBe("server not reachable");
        expect(reasonCategory("exit status 255")).toBe("ssh exited with 255");
        expect(reasonCategory("???")).toBe("connection failed");
    });
});

const CRED = ["dXNlcjpw", "YXNz"].join("");

describe("redact values", () => {
    it("removes a whole Authorization header value", () => {
        const out = redact(`Authorization: Basic ${CRED}\nnext line`, HOME);

        expect(out).not.toContain(CRED);
        expect(out).toContain("next line");
        expect(redact(`Proxy-Authorization: Basic ${CRED}`, HOME)).not.toContain(CRED);
    });

    it("removes a quoted value up to its closing quote", () => {
        const out = redact("password=\"open sesame\" host=x", HOME);

        expect(out).not.toContain("sesame");
        expect(out).not.toContain("open");
        expect(out).toContain("host=x");
        expect(redact("token: 'two words' end", HOME)).toBe("token=[removed] end");
    });
});

describe("redact holes", () => {
    it("removes a quoted value that holds an escaped quote", () => {
        const text = ["passwd", String.raw`"abc\"hunter2" host=x`].join("=");
        const out = redact(text, HOME);

        expect(out).not.toContain("hunter2");
        expect(out).toContain("host=x");
        expect(redact(String.raw`token='it\'s secret9' end`, HOME)).toBe("token=[removed] end");
    });

    it("removes a long base64 value that ends in padding", () => {
        const blob = `${"A".repeat(38)}==`;

        expect(redact(`key ${blob} end`, HOME)).toBe("key [removed] end");
        expect(redact(`key ${"B".repeat(39)}= end`, HOME)).toBe("key [removed] end");
    });

    it("hides a home folder whatever the case, slash or drive", () => {
        expect(redact(String.raw`open c:\users\alice\code`, String.raw`C:\Users\Alice`)).toBe(String.raw`open ~\code`);
        expect(redact("open C:/Users/Alice/code", String.raw`C:\Users\Alice`)).toBe("open ~/code");
        expect(redact(String.raw`open D:\Users\bob\x and /home/carol/y and /Users/dan/z`, HOME)).toBe(String.raw`open ~\x and ~/y and ~/z`);
    });
});

describe("the sandbox detail", () => {
    const withDetail = (sandboxDetail: string | null): SettingsView => {
        return { ...view, hosts: [{ ...host, sandboxDetail }] };
    };
    const line = (sandboxDetail: string | null): string =>
        (serverDiagnostics(withDetail(sandboxDetail), "dev_123", context) ?? "").split("\n").find((l) => l.startsWith("Shell sandbox:")) ?? "";

    it("is a category, so a short unlabelled secret never reaches the text", () => {
        expect(line("hunter2")).toBe("Shell sandbox: other");
        expect(line("Landlock ABI 5 hunter2")).toBe("Shell sandbox: other");
        expect(line(null)).toBe("Shell sandbox: not known");
    });

    it("names what the host software normally reports", () => {
        expect(sandboxCategory("Landlock ABI 5")).toBe("landlock");
        expect(sandboxCategory("macOS sandbox-exec")).toBe("sandbox-exec");
        expect(sandboxCategory("this Linux kernel has no Landlock (needs 5.13+ with Landlock enabled)")).toBe("none");
        expect(sandboxCategory("there is no shell sandbox on this operating system")).toBe("none");
        expect(sandboxCategory("/usr/bin/sandbox-exec is missing")).toBe("none");
    });
});

describe("the server platform", () => {
    it("is cut to harmless characters and redacted", () => {
        const odd: SettingsView = { ...view, hosts: [{ ...host, platform: `linux\nPassword=hunter2 <script>${"x".repeat(200)}` }] };
        const text = serverDiagnostics(odd, "dev_123", context) ?? "";
        const line = text.split("\n").find((l) => l.startsWith("Server platform:")) ?? "";

        expect(line).toBe("Server platform: other");
    });

    it("keeps the three names the host software uses", () => {
        const text = serverDiagnostics({ ...view, hosts: [{ ...host, platform: "macos" }] }, "dev_123", context) ?? "";

        expect(text).toContain("Server platform: macos");
    });
});

describe("the ssh route", () => {
    it("keeps a normal route and drops token-shaped users and addresses", () => {
        const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        const blob = "A".repeat(60);
        const odd: SettingsView = { ...view, hosts: [{ ...host, address: `${blob}.example.com`, user: token }] };
        const text = serverDiagnostics(odd, "dev_123", context) ?? "";

        expect(text).not.toContain(token);
        expect(text).not.toContain(blob);
        expect(text).toContain("Route: [tokenremoved]@");

        const plain: SettingsView = { ...view, hosts: [{ ...host, address: "example.com", port: 2222, user: "deploy" }] };

        expect(serverDiagnostics(plain, "dev_123", context)).toContain("Route: deploy@example.com:2222");
    });
});
