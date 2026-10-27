import { CLOUD_HEADLESS_CAPABILITIES, CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import type { CapabilityReport } from "@neore/ai/capabilities";
import type { Infer } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { vCapabilityReport } from "./capability-report";

type Stored = Infer<typeof vCapabilityReport>;

describe("vCapabilityReport", () => {
    // The validator and the shared type must accept each other's values, or a stored report drifts from what the UI reads.
    it("infers a type assignable to the shared type and back", () => {
        const toType = (report: Stored): CapabilityReport => report;
        const toStored = (report: CapabilityReport): Stored => report;

        expect(toType(toStored(CLOUD_INTERACTIVE_CAPABILITIES))).toEqual(CLOUD_INTERACTIVE_CAPABILITIES);
    });

    it.each([
        ["cloud interactive", CLOUD_INTERACTIVE_CAPABILITIES],
        ["cloud headless", CLOUD_HEADLESS_CAPABILITIES],
        ["local browser", LOCAL_BROWSER_CAPABILITIES],
    ])("accepts the %s declaration unchanged", (_name, report) => {
        expect(vCapabilityReport.parse(report)).toEqual(report);
    });

    it("accepts every degradation, an unsupported reason, and the lists", () => {
        const report: CapabilityReport = {
            groups: {
                checkpoints: { fileRollback: { degradation: "divergent", note: "agent memory stays", supported: true } },
                identity: { models: [{ id: "m", name: "M" }], reasoningEffort: { reason: "not_enforced", supported: false } },
                permissions: { modes: ["ask"] },
                sessions: { load: { degradation: "synthetic", note: "rebuilt from the transcript", supported: true } },
                turns: { followUp: { degradation: "restart", kind: "steer" } },
            },
            reportedAt: 1_700_000_000_000,
            version: 1,
        };

        expect(vCapabilityReport.parse(report)).toEqual(report);
    });

    it("accepts a report with no groups' members", () => {
        expect(vCapabilityReport.parse({ groups: {}, reportedAt: 1, version: 1 })).toEqual({ groups: {}, reportedAt: 1, version: 1 });
    });

    it.each([
        ["a supported capability with no degradation", { groups: { turns: { cancel: { supported: true } } }, reportedAt: 1, version: 1 }],
        ["a degraded capability with no note", { groups: { turns: { cancel: { degradation: "restart", supported: true } } }, reportedAt: 1, version: 1 }],
        ["an unsupported capability with no reason", { groups: { turns: { cancel: { supported: false } } }, reportedAt: 1, version: 1 }],
        [
            "a degradation outside the closed set",
            { groups: { turns: { cancel: { degradation: "emulated", note: "x", supported: true } } }, reportedAt: 1, version: 1 },
        ],
        ["an unknown follow-up kind", { groups: { turns: { followUp: { kind: "interrupt" } } }, reportedAt: 1, version: 1 }],
        ["a later version", { groups: {}, reportedAt: 1, version: 2 }],
        ["no reportedAt", { groups: {}, version: 1 }],
    ])("rejects %s", (_name, report) => {
        expect(() => vCapabilityReport.parse(report)).toThrow();
    });
});
