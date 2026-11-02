import { describe, expect, it } from "vitest";

import type { HostCapabilityKey, HostCapabilityReportInput } from "./capabilities";
import { hostCapabilityOf, isHostCapabilityAvailable } from "./capabilities";
import { GITHUB_CAPABILITIES } from "./drivers/github";

/** `Record<HostCapabilityKey, …>` makes this exhaustive: a member added to the type fails the type check here. */
const KEYS: Record<HostCapabilityKey, true> = {
    "checks.requiredState": true,
    "checks.rerun": true,
    "freshness.conditionalPolling": true,
    "freshness.webhooks": true,
    "inbox.drafts": true,
    "inbox.mine": true,
    "inbox.needsMyReview": true,
    "inbox.readyToMerge": true,
    "merge.auto": true,
    "merge.now": true,
    "pullRequest.checks": true,
    "pullRequest.commits": true,
    "pullRequest.create": true,
    "pullRequest.description": true,
    "pullRequest.diff": true,
    "pullRequest.files": true,
    "pullRequest.guide": true,
    "review.batchedSubmit": true,
    "review.lineComments": true,
    "review.replies": true,
    "review.resolveThreads": true,
    "review.verdictApprove": true,
    "review.verdictComment": true,
    "review.verdictRequestChanges": true,
    "review.viewedMarks": true,
};

describe("host capability rules", () => {
    it.each(Object.keys(KEYS) as HostCapabilityKey[])("reads %s as unsupported when the report lacks it", (key) => {
        for (const report of [undefined, null, {}, { groups: {} }, { groups: { inbox: {} } }]) {
            expect(hostCapabilityOf(report, key)).toEqual({ reason: "unknown", supported: false });
            expect(isHostCapabilityAvailable(report, key)).toBe(false);
        }
    });

    it("reads a member a driver declared", () => {
        expect(isHostCapabilityAvailable(GITHUB_CAPABILITIES as never, "inbox.needsMyReview")).toBe(true);
    });

    it("reads an unsupported member, and a malformed one, as unsupported", () => {
        // Malformed on purpose: a stored report may carry anything.
        const report = {
            groups: { inbox: { drafts: { supported: true }, mine: { reason: "not_offered", supported: false } } },
        } as unknown as HostCapabilityReportInput;

        expect(isHostCapabilityAvailable(report, "inbox.mine")).toBe(false);
        expect(isHostCapabilityAvailable(report, "inbox.drafts")).toBe(false);
    });

    it("words a reply as posted at once, not with the review", () => {
        expect(hostCapabilityOf(GITHUB_CAPABILITIES as never, "review.replies")).toMatchObject({ degradation: "divergent", supported: true });
    });

    it("declares every member the GitHub driver supports, and no more", () => {
        expect(Object.keys(KEYS).filter((key) => isHostCapabilityAvailable(GITHUB_CAPABILITIES as never, key as HostCapabilityKey))).toHaveLength(
            Object.keys(KEYS).length,
        );
    });
});
