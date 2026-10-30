import type { BranchNode } from "../types";
import { isSnoozed } from "./thread-state-rules";

export interface DerivedSections {
    /** Threads waiting for an approval or an answer, most recent activity first. */
    needsYou: BranchNode[];
    /** Everything that stays in the ordinary groups, in input order. */
    rest: BranchNode[];
    /** Threads still snoozed, waking soonest first. */
    snoozed: BranchNode[];
    /** Threads with a run in flight, most recent activity first. */
    working: BranchNode[];
}

type Candidate = Pick<BranchNode, "awaitingInput" | "isPinned" | "snoozedUntil" | "status">;

/**
 * Which derived section a thread belongs to, if any. A snooze beats everything (it is the owner's explicit
 * choice), then a pin keeps the thread where it is, then waiting for the owner beats running.
 */
const sectionOf = (thread: Candidate, now: number): "needsYou" | "rest" | "snoozed" | "working" => {
    if (isSnoozed(thread.snoozedUntil, now)) {
        return "snoozed";
    }

    if (thread.isPinned) {
        return "rest";
    }

    // A run in flight shows as streaming on its row, so it belongs under Working even if it also asks something.
    if (thread.status === "running") {
        return "working";
    }

    return thread.awaitingInput === undefined ? "rest" : "needsYou";
};

const activityOf = (thread: BranchNode): number => Math.max(thread.lastReplyAt ?? 0, thread.updatedAt ?? 0, thread.createdAt);

/** Splits root threads into the derived sections shown above and below the ordinary groups. Archived threads must be filtered out first. */
export const partitionDerivedSections = (threads: ReadonlyArray<BranchNode>, now: number): DerivedSections => {
    const sections: DerivedSections = { needsYou: [], rest: [], snoozed: [], working: [] };

    for (const thread of threads) {
        sections[sectionOf(thread, now)].push(thread);
    }

    const byActivity = (a: BranchNode, b: BranchNode) => activityOf(b) - activityOf(a);

    sections.needsYou.sort(byActivity);
    sections.working.sort(byActivity);
    sections.snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));

    return sections;
};

/** The next moment a snooze in `threads` ends, or undefined when none is pending. */
export const nextSnoozeWake = (threads: ReadonlyArray<Pick<BranchNode, "snoozedUntil">>, now: number): number | undefined => {
    let earliest: number | undefined;

    for (const thread of threads) {
        if (isSnoozed(thread.snoozedUntil, now) && (earliest === undefined || (thread.snoozedUntil ?? 0) < earliest)) {
            earliest = thread.snoozedUntil;
        }
    }

    return earliest;
};
