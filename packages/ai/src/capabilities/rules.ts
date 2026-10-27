/**
 * The only way UI and backend code reads a report. A control calls one of these
 * and never reaches into `report.groups`, so "absent" and `unknown` hide it
 * everywhere by construction.
 */
import type { Capability, CapabilityGroups, CapabilityReport } from "./types";

interface LooseGroups {
    [group: string]: { [member: string]: unknown } | undefined;
}

type GroupOf<G extends keyof CapabilityGroups> = NonNullable<CapabilityGroups[G]>;

/** `"turns.cancel"`: every group member that is a `Capability` (not a list or `followUp`). */
export type CapabilityKey = {
    [G in keyof CapabilityGroups & string]: {
        [M in keyof GroupOf<G> & string]-?: NonNullable<GroupOf<G>[M]> extends Capability ? `${G}.${M}` : never;
    }[keyof GroupOf<G> & string];
}[keyof CapabilityGroups & string];

/** A stored report may predate members added to the type, or be missing its groups entirely. */
export type CapabilityReportInput = Partial<Pick<CapabilityReport, "reportedAt" | "version">> & { groups?: CapabilityGroups };

export type FollowUpControl = "none" | "queue" | "steer" | "steer-restart";

export const UNKNOWN_CAPABILITY: Capability = { reason: "unknown", supported: false };

export const isAvailable = (capability: Capability | null | undefined): boolean => capability?.supported === true;

const isCapability = (value: unknown): value is Capability =>
    typeof value === "object" && value !== null && (value as { supported?: unknown }).supported !== undefined;

/** The member, or `unknown` when the report does not carry it. */
export const capabilityOf = (report: CapabilityReportInput | null | undefined, key: CapabilityKey): Capability => {
    const [group, member] = key.split(".") as [string, string];
    const value = (report?.groups as LooseGroups | undefined)?.[group]?.[member];

    return isCapability(value) ? value : UNKNOWN_CAPABILITY;
};

export const followUpControl = (report: CapabilityReportInput | null | undefined): FollowUpControl => {
    const followUp = report?.groups?.turns?.followUp;

    if (followUp?.kind === "steer") {
        return followUp.degradation === "restart" ? "steer-restart" : "steer";
    }

    return followUp?.kind === "queue" ? "queue" : "none";
};

/** The modes the runner enforces itself. A mode it lists but ignores is not in the list. */
export const visibleModes = (report: CapabilityReportInput | null | undefined): string[] => [...(report?.groups?.permissions?.modes ?? [])];

export const selectableModels = (report: CapabilityReportInput | null | undefined): { id: string; name: string }[] => [
    ...(report?.groups?.identity?.models ?? []),
];
