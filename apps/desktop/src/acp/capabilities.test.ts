import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import { reportFromHandshake } from "./capabilities";

const NOW = 1_700_000_000_000;

const available = (capabilities: Record<string, unknown>) => {
    const report = reportFromHandshake(capabilities, NOW);

    return {
        fork: isAvailable(capabilityOf(report, "sessions.fork")),
        list: isAvailable(capabilityOf(report, "sessions.listNative")),
        load: isAvailable(capabilityOf(report, "sessions.load")),
    };
};

describe("reportFromHandshake", () => {
    it("reports what the agent advertised", () => {
        expect(available({ loadSession: true, sessionCapabilities: { fork: {}, list: {} } })).toEqual({ fork: true, list: true, load: true });
        expect(reportFromHandshake({ loadSession: true }, NOW)).toMatchObject({ reportedAt: NOW, version: 1 });
    });

    it("reads an omitted, null or non-object member as not offered", () => {
        expect(available({})).toEqual({ fork: false, list: false, load: false });
        expect(available({ loadSession: false, sessionCapabilities: { fork: null, list: null } })).toEqual({ fork: false, list: false, load: false });
        expect(available({ loadSession: "yes", sessionCapabilities: { list: true } })).toEqual({ fork: false, list: false, load: false });
        expect(available({ sessionCapabilities: "list" })).toEqual({ fork: false, list: false, load: false });
    });

    it("reports each member on its own", () => {
        expect(available({ loadSession: true })).toEqual({ fork: false, list: false, load: true });
        expect(available({ sessionCapabilities: { list: {} } })).toEqual({ fork: false, list: true, load: false });
        expect(available({ sessionCapabilities: { fork: {} } })).toEqual({ fork: true, list: false, load: false });
    });

    it("leaves every other member unknown, whatever the agent is called", () => {
        const report = reportFromHandshake({ agentName: "claude-code", loadSession: true, promptCapabilities: { image: true } }, NOW);

        expect(capabilityOf(report, "turns.cancel")).toEqual({ reason: "unknown", supported: false });
        expect(capabilityOf(report, "sessions.create")).toEqual({ reason: "unknown", supported: false });
    });
});
