import type { CapabilityReport } from "@neore/ai/capabilities";
import { describe, expect, it } from "vitest";

import { canImportSessions } from "./import-control";

const NATIVE = { degradation: "none", supported: true } as const;
const report = (sessions: NonNullable<CapabilityReport["groups"]["sessions"]> | undefined): CapabilityReport => {
    return { groups: { sessions }, reportedAt: 1, version: 1 };
};

describe("the import control", () => {
    it("shows when the agent advertised listing and loading", () => {
        expect(canImportSessions(report({ listNative: NATIVE, load: NATIVE }))).toBe(true);
    });

    it("hides when there is no report", () => {
        expect(canImportSessions(undefined)).toBe(false);
        expect(canImportSessions(null)).toBe(false);
        expect(canImportSessions({ groups: {}, reportedAt: 1, version: 1 })).toBe(false);
        expect(canImportSessions(report(undefined))).toBe(false);
    });

    it("hides when a member is unknown or missing", () => {
        expect(canImportSessions(report({ listNative: NATIVE }))).toBe(false);
        expect(canImportSessions(report({ listNative: NATIVE, load: { reason: "unknown", supported: false } }))).toBe(false);
    });

    it("hides when a member is not offered, or not enforced", () => {
        expect(canImportSessions(report({ listNative: { reason: "not_offered", supported: false }, load: NATIVE }))).toBe(false);
        expect(canImportSessions(report({ listNative: NATIVE, load: { reason: "not_enforced", supported: false } }))).toBe(false);
    });

    it("hides when only one of the two is supported", () => {
        expect(canImportSessions(report({ listNative: NATIVE, load: { reason: "not_offered", supported: false } }))).toBe(false);
        expect(canImportSessions(report({ listNative: { reason: "not_offered", supported: false }, load: NATIVE }))).toBe(false);
    });

    it("reads a report that is not shaped like one as unknown", () => {
        expect(canImportSessions({ groups: { sessions: { listNative: { supported: true }, load: "yes" } } } as never)).toBe(false);
    });
});
