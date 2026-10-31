/**
 * What a pull request's checks add up to, with the host's own word on which of them
 * are required. Pure: the driver supplies the rules, nothing here calls a host.
 *
 * Only a check the host said is NOT required (`required === false`) is left out of the
 * verdict. A check whose requirement could not be read (`null`) counts as required, so
 * a host that withholds its rules can make a pull request look worse, never better.
 */
import { matchesGlob } from "./glob";
import type { CheckRun, CheckState, RequiredChecks } from "./types";

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

/** Longest list of waiting names (and each name) a rollup carries: patterns come from the host. */
const WAITING_MAX = 10;
const WAITING_NAME_MAX_CHARS = 200;

const WILDCARD = /[*?]/u;

/**
 * The checks the rules require by name that have not reported yet. A required check the host is still waiting on is
 * absent from the listing, so counting only what was listed would call that pull request ready. A pattern with a
 * wildcard names no one check and cannot be missing; each plain one with no listed check of that name is.
 */
export const waitingFor = (checks: CheckRun[], required: RequiredChecks): string[] => {
    const listed = new Set(checks.map((check) => check.name));

    return [...new Set(required.patterns)].filter((pattern) => !WILDCARD.test(pattern) && !listed.has(pattern));
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
    /** Required checks that have not reported at all yet (the first {@link WAITING_MAX}); each one holds the verdict at pending. */
    waiting: string[];
}

const NOT_PASSING = new Set<CheckState>(["cancelled", "failure"]);

const stateOf = (known: number, failing: number, pending: number): ChecksRollup["state"] => {
    if (known === 0) {
        return "none";
    }

    if (failing > 0) {
        return "failing";
    }

    return pending > 0 ? "pending" : "passing";
};

export const rollupOf = (checks: CheckRun[], total: number, required: RequiredChecks): ChecksRollup => {
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

    const waiting = waitingFor(checks, required);

    return {
        complete: total <= checks.length,
        failing,
        optionalFailing,
        pending,
        state: stateOf(checks.length + waiting.length, failing, pending + waiting.length),
        waiting: waiting.slice(0, WAITING_MAX).map((name) => name.slice(0, WAITING_NAME_MAX_CHARS)),
    };
};
