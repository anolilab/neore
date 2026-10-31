import { describe, expect, it } from "vitest";

import type { McpServerStatus } from "../types";
import { defaultServerTier, networkUnrestricted, serverNeedsAttention, serverSandboxText, tierAvailable } from "./server-network";

const status = (overrides: Partial<McpServerStatus>): McpServerStatus => {
    return { name: "docs", networkGap: null, note: "", problem: null, sandboxed: true, ...overrides };
};

describe("server network tiers", () => {
    it("defaults a new server to the middle tier only where it can be enforced", () => {
        expect(defaultServerTier({ dependenciesUnavailable: null })).toBe("dependencies");
        expect(defaultServerTier({ dependenciesUnavailable: "Linux cannot limit a program's network" })).toBe("off");
    });

    it("never offers the middle tier where it cannot be enforced", () => {
        const linux = { dependenciesUnavailable: "no" };
        const macos = { dependenciesUnavailable: null };

        expect(tierAvailable("dependencies", linux)).toBe(false);
        expect(tierAvailable("dependencies", macos)).toBe(true);
        expect(tierAvailable("off", linux)).toBe(true);
        expect(tierAvailable("on", linux)).toBe(true);
    });

    it("says the network is not restricted for a server that runs without a sandbox", () => {
        expect(networkUnrestricted(status({ sandboxed: false }))).toBe(true);
        expect(networkUnrestricted(status({ sandboxed: true }))).toBe(false);
        // Cannot start: nothing runs, and the tier will apply once it can.
        expect(networkUnrestricted(status({ problem: "no sandbox", sandboxed: false }))).toBe(false);
        expect(networkUnrestricted(undefined)).toBe(false);
    });

    it("words a sandboxed server's row, and says so when its network is not blocked after all", () => {
        expect(serverSandboxText(undefined)).toBe("");
        expect(serverSandboxText(status({}))).toBe("Sandboxed. ");
        expect(serverSandboxText(status({ problem: "no sandbox", sandboxed: false }))).toBe("Cannot start: no sandbox ");
        expect(serverSandboxText(status({ sandboxed: false }))).toContain("NOT sandboxed");

        const gap = status({ networkGap: "this CPU's seccomp filter is not available" });

        // Sandboxed, yet Off is not enforced: the row must not read as an unqualified "Sandboxed".
        expect(serverSandboxText(gap)).toContain("network is NOT restricted");
        expect(serverSandboxText(gap)).toContain("this CPU's seccomp filter is not available");
        expect(serverSandboxText(gap)).not.toBe("Sandboxed. ");
    });

    it("flags a server that is not fully confined as a warning", () => {
        expect(serverNeedsAttention(status({}))).toBe(false);
        expect(serverNeedsAttention(status({ networkGap: "no filter" }))).toBe(true);
        expect(serverNeedsAttention(status({ sandboxed: false }))).toBe(true);
        expect(serverNeedsAttention(status({ problem: "no sandbox", sandboxed: false }))).toBe(true);
        expect(serverNeedsAttention(undefined)).toBe(true);
    });
});
