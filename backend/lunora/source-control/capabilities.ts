/**
 * What a Git host's driver can do, declared in code and read with the same rules
 * as the runner capabilities (`@neore/ai/capabilities`): a member a driver did
 * not declare reads as `unknown`, and `unknown` is unsupported. UI code asks
 * `hostCapabilityOf`, never the host's name.
 */
import type { Capability } from "@neore/ai/capabilities";
import { capabilityIn, isAvailable } from "@neore/ai/capabilities";

export type HostCapabilityGroups = {
    checks?: {
        /** Which checks the base branch's rules require, so an optional failure is not red. */
        requiredState?: Capability;
        /** Re-run one check or job on its own, not the whole workflow. */
        rerun?: Capability;
    };
    freshness?: {
        /** A list read again with the validator of the last read costs nothing when nothing changed. */
        conditionalPolling?: Capability;
        /** The host can tell us a repository changed (a webhook the user installs); it only ever marks it dirty. */
        webhooks?: Capability;
    };
    inbox?: {
        drafts?: Capability;
        mine?: Capability;
        needsMyReview?: Capability;
        readyToMerge?: Capability;
    };
    merge?: {
        /** Merge once the host's rules are met. */
        auto?: Capability;
        now?: Capability;
    };
    pullRequest?: {
        checks?: Capability;
        commits?: Capability;
        description?: Capability;
        diff?: Capability;
        files?: Capability;
    };
    review?: {
        batchedSubmit?: Capability;
        lineComments?: Capability;
        replies?: Capability;
        resolveThreads?: Capability;
        verdictApprove?: Capability;
        verdictComment?: Capability;
        verdictRequestChanges?: Capability;
        /** Viewed marks the host keeps, so they follow the user to the host's own page. */
        viewedMarks?: Capability;
    };
};

export interface HostCapabilityReport {
    groups: HostCapabilityGroups;
    /** `0` on a static declaration: it was never reported by the host. */
    reportedAt: number;
    version: 1;
}

/** `"inbox.mine"`: every member of the groups above. */
export type HostCapabilityKey = {
    [G in keyof HostCapabilityGroups & string]: `${G}.${keyof NonNullable<HostCapabilityGroups[G]> & string}`;
}[keyof HostCapabilityGroups & string];

/** The wire shape: loosely keyed, so a report stored before a member existed still reads. */
export interface HostCapabilityReportInput {
    groups?: { [group: string]: { [member: string]: Capability } | undefined };
}

export const hostCapabilityOf = (report: HostCapabilityReportInput | null | undefined, key: HostCapabilityKey): Capability => capabilityIn(report?.groups, key);

export const isHostCapabilityAvailable = (report: HostCapabilityReportInput | null | undefined, key: HostCapabilityKey): boolean =>
    isAvailable(hostCapabilityOf(report, key));
