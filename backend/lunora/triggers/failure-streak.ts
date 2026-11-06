/**
 * When a trigger stops retrying on its own.
 *
 * A run that fails for a reason only its owner can fix (the model is no longer
 * offered, the custom endpoint is gone, the plan no longer covers the model)
 * fails the same way on every later run. After {@link TRIGGER_PAUSE_AFTER_FAILURES}
 * such runs in a row the trigger pauses and tells the owner; one no later run can cure
 * (the owner left the trigger's organization) pauses it at once. Everything else —
 * a provider outage, a timeout, a rate limit, the daily run limit — says nothing
 * about the trigger itself, so it neither counts nor resets the streak.
 */
import type { AgentRunErrorKind } from "../chat/lib/agent-run";

/** Consecutive user-fixable failed runs after which an enabled trigger pauses. */
export const TRIGGER_PAUSE_AFTER_FAILURES = 3;

/** The run errors a run raises itself (`AgentRunError`) that only the owner's settings can cure. */
export const USER_FIXABLE_RUN_ERRORS: ReadonlySet<AgentRunErrorKind> = new Set<AgentRunErrorKind>([
    "custom-endpoint",
    "left-organization",
    "local-endpoint",
    "plan-required",
]);

/** Of those, the ones no later run can cure (the owner left the trigger's organization): the first one pauses the trigger. */
export const PERMANENT_RUN_ERRORS: ReadonlySet<AgentRunErrorKind> = new Set<AgentRunErrorKind>(["left-organization"]);

const MODEL_UNAVAILABLE_SUFFIX = "' is no longer available for triggers. Pick another model and enable the trigger again.";

/** The admission refusal for a model triggers may no longer use. Classified by {@link isModelUnavailableRefusal}, so the two share the text. */
export const modelUnavailableMessage = (model: string): string => `The model '${model}${MODEL_UNAVAILABLE_SUFFIX}`;

export const isModelUnavailableRefusal = (refusal: string): boolean => refusal.startsWith("The model '") && refusal.endsWith(MODEL_UNAVAILABLE_SUFFIX);

export type RunOutcome = "permanent" | "success" | "transient" | "user-fixable";

/**
 * How one settled run counts: a success, a failure no later run can cure (`permanent`), a failure only the owner can
 * cure (`userFixable`), or any other failure.
 */
export const runOutcome = (status: string, userFixable: boolean | undefined, permanent?: boolean): RunOutcome => {
    if (status === "completed") {
        return "success";
    }

    if (permanent === true) {
        return "permanent";
    }

    return userFixable === true ? "user-fixable" : "transient";
};

/** The streak after one settled run, and whether that run is the one that pauses the trigger. */
export const advanceStreak = (streak: number, outcome: RunOutcome): { pause: boolean; streak: number } => {
    if (outcome === "success") {
        return { pause: false, streak: 0 };
    }

    if (outcome === "transient") {
        return { pause: false, streak };
    }

    const next = streak + 1;

    return { pause: outcome === "permanent" || next >= TRIGGER_PAUSE_AFTER_FAILURES, streak: next };
};

/** The notification body for a paused trigger: what happened, then why the last run failed. A permanent failure says only why. */
export const pausedNoticeBody = (error: string | undefined, permanent = false): string => {
    if (permanent) {
        return `Paused. ${error ?? "It cannot run again as it is."}`;
    }

    return `Paused after ${String(TRIGGER_PAUSE_AFTER_FAILURES)} failed runs in a row. Fix the cause and turn the trigger back on.${error ? ` Last error: ${error}` : ""}`;
};
