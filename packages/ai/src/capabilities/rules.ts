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

/** A report that says nothing: every member reads as `unknown`, so every control it gates is hidden. */
export const unknownCapabilityReport = (reportedAt: number): CapabilityReport => ({ groups: {}, reportedAt, version: 1 });

export const isAvailable = (capability: Capability | null | undefined): boolean => capability?.supported === true;

const DEGRADATIONS = new Set<unknown>(["divergent", "restart", "synthetic"]);
const UNSUPPORTED_REASONS = new Set<unknown>(["not_enforced", "not_offered", "unknown"]);

const isCapability = (value: unknown): value is Capability => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const { degradation, note, reason, supported } = value as { degradation?: unknown; note?: unknown; reason?: unknown; supported?: unknown };

    if (supported === true) {
        return degradation === "none" || (DEGRADATIONS.has(degradation) && typeof note === "string");
    }

    return supported === false && UNSUPPORTED_REASONS.has(reason);
};

/** The member, or `unknown` when the report does not carry it. */
export const capabilityOf = (report: CapabilityReportInput | null | undefined, key: CapabilityKey): Capability => {
    const [group, member] = key.split(".") as [string, string];
    const value = (report?.groups as LooseGroups | undefined)?.[group]?.[member];

    return isCapability(value) ? value : UNKNOWN_CAPABILITY;
};

export const followUpControl = (report: CapabilityReportInput | null | undefined): FollowUpControl => {
    const followUp = report?.groups?.turns?.followUp;

    if (followUp?.kind === "steer") {
        if (followUp.degradation === undefined) {
            return "steer";
        }

        return followUp.degradation === "restart" ? "steer-restart" : "none";
    }

    return followUp?.kind === "queue" ? "queue" : "none";
};

/** The modes the runner enforces itself. A mode it lists but ignores is not in the list. */
export const visibleModes = (report: CapabilityReportInput | null | undefined): string[] => {
    const modes: unknown = report?.groups?.permissions?.modes;

    return Array.isArray(modes) ? [...modes] : [];
};

export const selectableModels = (report: CapabilityReportInput | null | undefined): { id: string; name: string }[] => {
    const models: unknown = report?.groups?.identity?.models;

    return Array.isArray(models) ? [...models] : [];
};
