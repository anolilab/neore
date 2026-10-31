import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import { reportFromHandshake } from "./capabilities";

const NOW = 1_700_000_000_000;

const available = (capabilities: Record<string, unknown>) => {
    const report = reportFromHandshake(capabilities, NOW);

    return { list: isAvailable(capabilityOf(report, "sessions.listNative")), load: isAvailable(capabilityOf(report, "sessions.load")) };
};

describe("reportFromHandshake", () => {
    it("reports what the agent advertised", () => {
        expect(available({ loadSession: true, sessionCapabilities: { list: {} } })).toEqual({ list: true, load: true });
        expect(reportFromHandshake({ loadSession: true }, NOW)).toMatchObject({ reportedAt: NOW, version: 1 });
    });

    it("reads an omitted, null or non-object member as not offered", () => {
        expect(available({})).toEqual({ list: false, load: false });
        expect(available({ loadSession: false, sessionCapabilities: { list: null } })).toEqual({ list: false, load: false });
        expect(available({ loadSession: "yes", sessionCapabilities: { list: true } })).toEqual({ list: false, load: false });
        expect(available({ sessionCapabilities: "list" })).toEqual({ list: false, load: false });
    });

    it("reports each member on its own", () => {
        expect(available({ loadSession: true })).toEqual({ list: false, load: true });
        expect(available({ sessionCapabilities: { list: {} } })).toEqual({ list: true, load: false });
    });

    it("leaves every other member unknown, whatever the agent is called", () => {
        const report = reportFromHandshake({ agentName: "claude-code", loadSession: true, promptCapabilities: { image: true } }, NOW);

        expect(capabilityOf(report, "turns.cancel")).toEqual({ reason: "unknown", supported: false });
        expect(capabilityOf(report, "sessions.create")).toEqual({ reason: "unknown", supported: false });
    });
});
