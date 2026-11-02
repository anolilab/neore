/**
 * The lock decision and the effective read are pure, so they are tested
 * directly: the test harness cannot seed the global user or organization tables.
 */
import { describe, expect, it } from "vitest";

import { effectiveSetting, lockedKeysInPatch, NO_POLICY, readPolicyState } from "./organization-policy";
import type { PolicyState } from "./organization-policy";

const stateOf = (document: unknown): PolicyState => readPolicyState(JSON.stringify(document));

const lockedMemoryOff = stateOf({ schemaVersion: 1, settings: { memoryEnabled: { locked: true, value: false } } });
const unlockedSummariesOn = stateOf({ schemaVersion: 1, settings: { threadSummariesEnabled: { locked: false, value: true } } });
const unreadable = readPolicyState("{ not json");

describe("readPolicyState", () => {
    it("tells no row, a policy and a broken document apart", () => {
        expect(readPolicyState(undefined)).toBe(NO_POLICY);
        expect(readPolicyState(null)).toBe(NO_POLICY);
        expect(lockedMemoryOff.kind).toBe("policy");
        expect(unreadable).toEqual({ kind: "unreadable" });
        expect(readPolicyState('{"schemaVersion":1,"typo":true}')).toEqual({ kind: "unreadable" });
    });
});

describe("lockedKeysInPatch", () => {
    it("refuses a write to a locked key, whatever the value", () => {
        expect(lockedKeysInPatch({ memoryEnabled: true }, lockedMemoryOff)).toEqual(["memoryEnabled"]);
        expect(lockedKeysInPatch({ memoryEnabled: false }, lockedMemoryOff)).toEqual(["memoryEnabled"]);
    });

    it("allows an unlocked default, a key the policy does not name and a patch with no policy", () => {
        expect(lockedKeysInPatch({ threadSummariesEnabled: false }, unlockedSummariesOn)).toEqual([]);
        expect(lockedKeysInPatch({ dailyBriefEnabled: true }, lockedMemoryOff)).toEqual([]);
        expect(lockedKeysInPatch({ memoryEnabled: true }, NO_POLICY)).toEqual([]);
    });

    it("ignores a locked key the patch leaves undefined", () => {
        expect(lockedKeysInPatch({ memoryEnabled: undefined, timezone: "UTC" }, lockedMemoryOff)).toEqual([]);
    });

    it("names every locked key in a mixed patch, sorted, and nothing else", () => {
        const state = stateOf({
            schemaVersion: 1,
            settings: { dailyBriefEnabled: { locked: true, value: true }, memoryEnabled: { locked: true, value: false } },
        });

        expect(lockedKeysInPatch({ dailyBriefEnabled: false, memoryEnabled: true, timezone: "UTC" }, state)).toEqual(["dailyBriefEnabled", "memoryEnabled"]);
    });

    it("fails closed on a policy that cannot be read, for managed keys only", () => {
        expect(lockedKeysInPatch({ autoApproveLowRisk: true, memoryEnabled: false }, unreadable)).toEqual(["autoApproveLowRisk", "memoryEnabled"]);
        expect(lockedKeysInPatch({ timezone: "UTC", toolPermissions: {} }, unreadable)).toEqual([]);
    });
});

describe("effectiveSetting", () => {
    it("reads the locked value, over the user's own", () => {
        expect(effectiveSetting("memoryEnabled", true, lockedMemoryOff)).toBe(false);
        expect(effectiveSetting("memoryEnabled", undefined, lockedMemoryOff)).toBe(false);
    });

    it("reads the user's own value for a key the policy leaves free", () => {
        expect(effectiveSetting("dailyBriefEnabled", true, lockedMemoryOff)).toBe(true);
        expect(effectiveSetting("dailyBriefEnabled", undefined, lockedMemoryOff)).toBeUndefined();
        expect(effectiveSetting("memoryEnabled", true, NO_POLICY)).toBe(true);
    });

    it("applies an unlocked default only until the user chooses", () => {
        expect(effectiveSetting("threadSummariesEnabled", undefined, unlockedSummariesOn)).toBe(true);
        expect(effectiveSetting("threadSummariesEnabled", false, unlockedSummariesOn)).toBe(false);
    });

    it("keeps the user's own value when the policy cannot be read", () => {
        expect(effectiveSetting("memoryEnabled", true, unreadable)).toBe(true);
        expect(effectiveSetting("memoryEnabled", undefined, unreadable)).toBeUndefined();
    });
});
