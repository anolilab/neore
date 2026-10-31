import { describe, expect, it } from "vitest";

import { CLOUD_HEADLESS_CAPABILITIES, CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES } from "./declarations";
import type { CapabilityKey } from "./rules";
import { capabilityIn, capabilityOf, followUpControl, isAvailable, selectableModels, UNKNOWN_CAPABILITY, unknownCapabilityReport, visibleModes } from "./rules";
import type { Capability, CapabilityGroups, CapabilityReport } from "./types";

/** `Record<CapabilityKey, …>` makes this list exhaustive: a member added to the type fails the type check here. */
const CAPABILITY_KEYS: Record<CapabilityKey, true> = {
    "checkpoints.fileRollback": true,
    "checkpoints.memoryRollback": true,
    "context.compactOnRequest": true,
    "context.usageMeter": true,
    "identity.account": true,
    "identity.reasoningEffort": true,
    "planning.planMode": true,
    "sessions.create": true,
    "sessions.listNative": true,
    "sessions.load": true,
    "streaming.reasoning": true,
    "streaming.text": true,
    "streaming.toolParts": true,
    "subagents.ownChildren": true,
    "tools.approvalRequest": true,
    "tools.call": true,
    "tools.declinePath": true,
    "turns.cancel": true,
};

const NATIVE: Capability = { degradation: "none", supported: true };

const ALL_KEYS = Object.keys(CAPABILITY_KEYS) as CapabilityKey[];

/** A report carrying exactly these capabilities, each supported. */
const reportOf = (keys: CapabilityKey[]): CapabilityReport => {
    const groups: Record<string, Record<string, Capability>> = {};

    for (const key of keys) {
        const [group, member] = key.split(".") as [string, string];
        const members = groups[group] ?? {};

        members[member] = NATIVE;
        groups[group] = members;
    }

    return { groups: groups as CapabilityGroups, reportedAt: 1, version: 1 };
};

const without = (key: CapabilityKey): CapabilityReport => reportOf(ALL_KEYS.filter((other) => other !== key));

describe("capabilityOf", () => {
    it.each(ALL_KEYS)("reads %s as supported when the report carries it", (key) => {
        const capability = capabilityOf(reportOf(ALL_KEYS), key);

        expect(isAvailable(capability)).toBe(true);
    });

    it.each(ALL_KEYS)("reads %s as unsupported when the report lacks it", (key) => {
        const capability = capabilityOf(without(key), key);

        expect(capability).toEqual(UNKNOWN_CAPABILITY);
        expect(isAvailable(capability)).toBe(false);
    });

    it.each(ALL_KEYS)("reads %s as unsupported on an unknown report", (key) => {
        const capability = capabilityOf(unknownCapabilityReport(5), key);

        expect(isAvailable(capability)).toBe(false);
        expect(unknownCapabilityReport(5)).toEqual({ groups: {}, reportedAt: 5, version: 1 });
    });

    it.each(ALL_KEYS)("reads %s as unsupported with no report, or no groups", (key) => {
        expect(isAvailable(capabilityOf(undefined, key))).toBe(false);
        expect(isAvailable(capabilityOf(null, key))).toBe(false);
        expect(isAvailable(capabilityOf({}, key))).toBe(false);
    });

    it("reads a malformed member as unknown", () => {
        const report = { groups: { turns: { cancel: "yes" } } } as unknown as CapabilityReport;

        expect(capabilityOf(report, "turns.cancel")).toEqual(UNKNOWN_CAPABILITY);
    });
});

describe("isAvailable", () => {
    it("is true only for a supported capability, whatever its degradation", () => {
        expect(isAvailable(NATIVE)).toBe(true);
        expect(isAvailable({ degradation: "restart", note: "ends the run", supported: true })).toBe(true);
        expect(isAvailable({ degradation: "divergent", note: "memory differs", supported: true })).toBe(true);
    });

    it.each(["not_offered", "not_enforced", "unknown"] as const)("is false for %s", (reason) => {
        expect(isAvailable({ reason, supported: false })).toBe(false);
    });

    it("is false for a missing capability", () => {
        expect(isAvailable(undefined)).toBe(false);
        expect(isAvailable(null)).toBe(false);
    });
});

describe("followUpControl", () => {
    it("is queue for a headless run and steer for a cloud interactive one", () => {
        expect(followUpControl(CLOUD_HEADLESS_CAPABILITIES)).toBe("queue");
        expect(followUpControl(CLOUD_INTERACTIVE_CAPABILITIES)).toBe("steer");
    });

    it("is queue for a local browser model", () => {
        expect(followUpControl(LOCAL_BROWSER_CAPABILITIES)).toBe("queue");
    });

    it("is none for a steer degradation outside the declared shape", () => {
        expect(followUpControl({ groups: { turns: { followUp: { degradation: "bogus", kind: "steer" } } } } as unknown as CapabilityReport)).toBe("none");
    });

    it("is steer-restart for a steer that ends the run first", () => {
        expect(followUpControl({ groups: { turns: { followUp: { degradation: "restart", kind: "steer" } } } })).toBe("steer-restart");
    });

    it("is none when the report does not say", () => {
        expect(followUpControl(undefined)).toBe("none");
        expect(followUpControl({})).toBe("none");
        expect(followUpControl({ groups: { turns: {} } })).toBe("none");
        expect(followUpControl({ groups: { turns: { followUp: { kind: "interrupt" } } } } as unknown as CapabilityReport)).toBe("none");
    });
});

describe("visibleModes", () => {
    it("returns the modes the report lists", () => {
        expect(visibleModes({ groups: { permissions: { modes: ["ask", "auto"] } } })).toEqual(["ask", "auto"]);
    });

    it("is empty when the report lacks them, or lists none", () => {
        expect(visibleModes(undefined)).toEqual([]);
        expect(visibleModes({ groups: {} })).toEqual([]);
        expect(visibleModes({ groups: { permissions: { modes: [] } } })).toEqual([]);
    });

    it("hands back a copy", () => {
        const report: CapabilityReport = { groups: { permissions: { modes: ["ask"] } }, reportedAt: 1, version: 1 };

        visibleModes(report).push("auto");

        expect(report.groups.permissions?.modes).toEqual(["ask"]);
    });
});

describe("malformed reports", () => {
    it("reads a supported member without a valid degradation, or a degraded one without its note, as unknown", () => {
        const read = (member: unknown) => capabilityOf({ groups: { turns: { cancel: member } } } as unknown as CapabilityReport, "turns.cancel");

        expect(read({ degradation: "bogus", supported: true })).toBe(UNKNOWN_CAPABILITY);
        expect(read({ degradation: "restart", supported: true })).toBe(UNKNOWN_CAPABILITY);
        expect(read({ reason: "bogus", supported: false })).toBe(UNKNOWN_CAPABILITY);
    });

    it("returns an empty list for modes or models that are not arrays", () => {
        expect(visibleModes({ groups: { permissions: { modes: 3 } } } as unknown as CapabilityReport)).toEqual([]);
        expect(selectableModels({ groups: { identity: { models: { length: 1 } } } } as unknown as CapabilityReport)).toEqual([]);
    });
});

describe("selectableModels", () => {
    it("returns the models the report lists, and none when it lacks them", () => {
        expect(selectableModels({ groups: { identity: { models: [{ id: "a", name: "A" }] } } })).toEqual([{ id: "a", name: "A" }]);
        expect(selectableModels(undefined)).toEqual([]);
        expect(selectableModels({ groups: { identity: {} } })).toEqual([]);
    });
});

describe("static declarations", () => {
    const declarations = { CLOUD_HEADLESS_CAPABILITIES, CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES };

    it.each(Object.entries(declarations))("%s lists no modes or models", (_name, report) => {
        const claimed = ALL_KEYS.filter((key) => isAvailable(capabilityOf(report, key)));

        expect(claimed.length).toBeGreaterThan(0);
        expect(visibleModes(report)).toEqual([]);
        expect(selectableModels(report)).toEqual([]);
    });

    it("gives the local model text and cancel only, and a headless run cancel only", () => {
        const claimed = (report: CapabilityReport) => ALL_KEYS.filter((key) => isAvailable(capabilityOf(report, key)));

        expect(claimed(LOCAL_BROWSER_CAPABILITIES)).toEqual(["streaming.text", "turns.cancel"]);
        expect(isAvailable(capabilityOf(CLOUD_INTERACTIVE_CAPABILITIES, "streaming.toolParts"))).toBe(false);
        expect(claimed(CLOUD_HEADLESS_CAPABILITIES)).toEqual(["turns.cancel"]);
    });

    it("lets a run with a stream take tool approval, with a decline path", () => {
        for (const key of ["tools.call", "tools.approvalRequest", "tools.declinePath"] as const) {
            expect(isAvailable(capabilityOf(CLOUD_INTERACTIVE_CAPABILITIES, key))).toBe(true);
        }
    });
});

describe("capabilityIn", () => {
    const groups = { inbox: { mine: { degradation: "none", supported: true }, stale: { supported: true }, wrong: "yes" } };

    it("reads a member of any group map", () => {
        expect(capabilityIn(groups, "inbox.mine")).toEqual({ degradation: "none", supported: true });
    });

    it.each(["inbox.absent", "elsewhere.mine", "inbox.stale", "inbox.wrong"])("reads %s as unknown", (key) => {
        expect(capabilityIn(groups, key)).toEqual(UNKNOWN_CAPABILITY);
    });

    it("reads a missing map as unknown", () => {
        expect(capabilityIn(undefined, "inbox.mine")).toEqual(UNKNOWN_CAPABILITY);
        expect(capabilityIn(null, "inbox.mine")).toEqual(UNKNOWN_CAPABILITY);
    });
});
