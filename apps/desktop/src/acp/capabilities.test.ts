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
    const base = reportFromHandshake({ loadSession: true }, NOW);
    const model = {
        category: "model",
        choices: [
            { name: "Fast", value: "fast" },
            { name: "Deep", value: "deep" },
        ],
        currentValue: "fast",
        id: "m",
        name: "Model",
    };
    const effort = { category: "thought_level", choices: [{ name: "High", value: "high" }], currentValue: "high", id: "e", name: "Effort" };
    const mode = { category: "mode", choices: [{ name: "Ask", value: "ask" }, { name: "Code", value: "code" }], currentValue: "ask", id: "p", name: "Mode" };
    const groups = (options: Parameters<typeof withOptionCapabilities>[1]) => withOptionCapabilities(base, options).groups;

    it("lists the models of a model option, by its choices", () => {
        expect(groups({ configOptions: [model] }).identity?.models).toEqual([
            { id: "fast", name: "Fast" },
            { id: "deep", name: "Deep" },
        ]);
    });

    it("reports reasoning effort when the agent has a thought-level option", () => {
        expect(capabilityOf(withOptionCapabilities(base, { configOptions: [effort] }), "identity.reasoningEffort")).toEqual({ degradation: "none", supported: true });
    });

    it("does not report a mode option as a permission mode: the session's modes are not the runner's", () => {
        expect(groups({ configOptions: [mode] }).permissions?.modes ?? []).toEqual([]);
    });

    it("does not offer the legacy models, which the agent cannot change", () => {
        expect(groups({ models: { available: [{ id: "m1", name: "M1" }], current: "m1" } }).identity?.models).toEqual([]);
    });

    it("does not report the legacy modes as permission modes", () => {
        expect(groups({ modes: { available: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }], current: "ask" } }).permissions?.modes ?? []).toEqual([]);
    });

    it("takes the options over the legacy states", () => {
        const both = groups({
            configOptions: [model, mode],
            models: { available: [{ id: "legacy", name: "L" }], current: "legacy" },
            modes: { available: [{ id: "legacy", name: "L" }], current: "legacy" },
        });

        expect(both.identity?.models).toEqual([
            { id: "fast", name: "Fast" },
            { id: "deep", name: "Deep" },
        ]);
        expect(both.permissions?.modes ?? []).toEqual([]);
    });

    it("reports nothing offered when the agent offered none, and keeps the handshake members", () => {
        const none = withOptionCapabilities(base, {});

        expect(none.groups.identity).toEqual({ models: [], reasoningEffort: { reason: "not_offered", supported: false } });
        // The permission group is the handshake's own: session modes are not reported there.
        expect(none.groups.permissions).toBeUndefined();
        expect(isAvailable(capabilityOf(none, "sessions.load"))).toBe(true);
        expect(none.reportedAt).toBe(NOW);
    });

    it("reads an option of another category as none of the three", () => {
        const other = groups({ configOptions: [{ ...model, category: "model_config" }] });

        expect(other.identity?.models).toEqual([]);
        expect(other.permissions?.modes ?? []).toEqual([]);
    });

    it("never reads a name: an agent called anything reports the same", () => {
        expect(withOptionCapabilities(reportFromHandshake({ agentName: "claude-code", loadSession: true }, NOW), {}).groups).toEqual(withOptionCapabilities(base, {}).groups);
    });
});
