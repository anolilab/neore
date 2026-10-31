import { describe, expect, it } from "vitest";

import type { McpServerStatus } from "../types";
import { defaultServerTier, networkUnrestricted, tierAvailable } from "./server-network";

const status = (overrides: Partial<McpServerStatus>): McpServerStatus => {
    return { name: "docs", note: "", problem: null, sandboxed: true, ...overrides };
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
});
