import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import { reportFromHandshake, withOptionCapabilities } from "./capabilities";

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

describe("withOptionCapabilities", () => {
    const choice = (value: string) => {
        return { name: value.toUpperCase(), value };
    };

    it("reports the model choices and a reasoning-effort option by their category, never by name", () => {
        const report = withOptionCapabilities(
            reportFromHandshake({ loadSession: true }, NOW),
            {
                configOptions: [
                    { category: "model", choices: [choice("a"), choice("b")], currentValue: "a", id: "m", name: "Model" },
                    { category: "thought_level", choices: [choice("low")], currentValue: "low", id: "effort", name: "Effort" },
                ],
            },
            NOW + 1,
        );

        expect(report.groups.identity).toEqual({
            models: [
                { id: "a", name: "A" },
                { id: "b", name: "B" },
            ],
            reasoningEffort: { degradation: "none", supported: true },
        });
        expect(report.reportedAt).toBe(NOW + 1);
        expect(isAvailable(capabilityOf(report, "sessions.load"))).toBe(true);
    });

    it("lists the choices of every option filed under model, each model once", () => {
        const report = withOptionCapabilities(
            reportFromHandshake({}, NOW),
            {
                configOptions: [
                    { category: "model", choices: [], currentValue: "a", id: "m1", name: "Model" },
                    { category: "model", choices: [choice("a"), choice("c")], currentValue: "a", id: "m2", name: "Fallback" },
                    { category: "model", choices: [choice("c")], currentValue: "c", id: "m3", name: "Small" },
                ],
            },
            NOW,
        );

        expect(report.groups.identity?.models).toEqual([
            { id: "a", name: "A" },
            { id: "c", name: "C" },
        ]);
    });

    it("reports neither for an agent that offers no such option", () => {
        const report = withOptionCapabilities(
            reportFromHandshake({}, NOW),
            { configOptions: [{ choices: [choice("x")], currentValue: "x", id: "model", name: "Model" }] },
            NOW,
        );

        expect(report.groups.identity).toEqual({ models: [], reasoningEffort: { reason: "not_offered", supported: false } });
    });
});
