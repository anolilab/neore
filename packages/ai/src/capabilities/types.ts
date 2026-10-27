/**
 * What a RUNNER (the cloud agent loop, a headless sub-agent run, an agent on a
 * host) can do. Not to be confused with `models/capabilities.ts`, which is about
 * what a MODEL accepts as input.
 *
 * Plain data, no imports: the web app, the desktop main process, the backend and
 * the mobile app all read this subpath. See plans/provider-capabilities.md.
 */

/**
 * - `none`: works natively.
 * - `restart`: works by ending the current run and starting another.
 * - `synthetic`: Neore emulates it (a fork rebuilt from the saved transcript).
 * - `divergent`: works, but the runner's own memory no longer matches what the
 *   user sees (a file rollback that leaves the agent's context as it was).
 *
 * The set is closed so the UI can handle every case; a value is added only by
 * owner decision.
 */
export type CapabilityDegradation = "none" | "restart" | "synthetic" | "divergent";

/**
 * - `not_offered`: the runner does not have it.
 * - `not_enforced`: the runner accepts the setting but does not enforce it.
 * - `unknown`: the runner did not say.
 *
 * All three hide the control.
 */
export type CapabilityUnsupportedReason = "not_offered" | "not_enforced" | "unknown";

export type Capability =
    | { degradation: "none"; supported: true }
    | { degradation: Exclude<CapabilityDegradation, "none">; note: string; supported: true }
    | { reason: CapabilityUnsupportedReason; supported: false };

/**
 * How a message sent while a run is going is handled. A value rather than a
 * `Capability`, because the two ways differ in what they do, not just in whether
 * they work: `steer` lands in the running turn, `queue` waits for it to end.
 * `restart` is a steer that has to end the run first.
 */
export type FollowUp = { degradation?: "restart"; kind: "steer" } | { kind: "queue" } | { kind: "none" };

/**
 * Every member is optional: a member a runner did not report, or one added to
 * this type after a report was stored, reads as `unknown`. Read through the
 * rules in `./rules`, never off this object.
 */
export interface CapabilityGroups {
    checkpoints?: {
        fileRollback?: Capability;
        memoryRollback?: Capability;
    };
    context?: {
        compactOnRequest?: Capability;
        usageMeter?: Capability;
    };
    identity?: {
        account?: Capability;
        /** Selectable models; an empty list means "not offered". */
        models?: { id: string; name: string }[];
        reasoningEffort?: Capability;
    };
    permissions?: {
        /** The modes the runner enforces itself; an empty list means "not offered". */
        modes?: string[];
    };
    planning?: {
        planMode?: Capability;
    };
    sessions?: {
        create?: Capability;
        listNative?: Capability;
        load?: Capability;
    };
    streaming?: {
        reasoning?: Capability;
        text?: Capability;
        toolParts?: Capability;
    };
    subagents?: {
        /** The runner spawns its own children. */
        ownChildren?: Capability;
    };
    tools?: {
        approvalRequest?: Capability;
        call?: Capability;
        declinePath?: Capability;
    };
    turns?: {
        cancel?: Capability;
        followUp?: FollowUp;
    };
}

export interface CapabilityReport {
    groups: CapabilityGroups;
    /** Epoch milliseconds. `0` on a static declaration: it was never reported. */
    reportedAt: number;
    /** Lets a stored report be read after the type grows. */
    version: 1;
}
