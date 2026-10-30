/**
 * What a pull request's checks add up to, with the host's own word on which of them
 * are required. Pure: the driver supplies the rules, nothing here calls a host.
 *
 * Only a check the host said is NOT required (`required === false`) is left out of the
 * verdict. A check whose requirement could not be read (`null`) counts as required, so
 * a host that withholds its rules can make a pull request look worse, never better.
 */
import { matchesGlob } from "./glob";
import type { CheckRun, CheckState } from "./types";

/** The patterns a branch's rules require, and whether every source of those rules could be read. */
export interface RequiredChecks {
    /** `false` when a source was unreadable: a check no pattern names is then unknown, not optional. */
    complete: boolean;
    patterns: string[];
}

/** `true`/`false` as the rules say; `null` when they cannot say. */
export const requirementOf = (name: string, required: RequiredChecks): boolean | null => {
    let undecided = !required.complete;

    for (const pattern of required.patterns) {
        const matched = matchesGlob(pattern, name);

        if (matched === true) {
            return true;
        }

        // A pattern too long to compare might have named this check.
        undecided ||= matched === null;
    }

    return undecided ? null : false;
};

export interface ChecksRollup {
    /** `false` when the host holds more checks than were listed: a pass here is not a pass overall. */
    complete: boolean;
    /** Required (or unknown) checks that failed or were cancelled. */
    failing: number;
    /** Checks the host does not require that failed or were cancelled: shown, not counted as red. */
    optionalFailing: number;
    /** Required (or unknown) checks still running. */
    pending: number;
    state: "failing" | "none" | "passing" | "pending";
}

const NOT_PASSING = new Set<CheckState>(["cancelled", "failure"]);

const stateOf = (listed: number, failing: number, pending: number): ChecksRollup["state"] => {
    if (listed === 0) {
        return "none";
    }

    if (failing > 0) {
        return "failing";
    }

    return pending > 0 ? "pending" : "passing";
};

export const rollupOf = (checks: CheckRun[], total: number): ChecksRollup => {
    let failing = 0;
    let optionalFailing = 0;
    let pending = 0;

    for (const check of checks) {
        const counts = check.required !== false;

        if (NOT_PASSING.has(check.state)) {
            if (counts) {
                failing += 1;
            } else {
                optionalFailing += 1;
            }
        } else if (check.state === "pending" && counts) {
            pending += 1;
        }
    }

    return { complete: total <= checks.length, failing, optionalFailing, pending, state: stateOf(checks.length, failing, pending) };
};
