/**
 * A run whose worker died (a deploy, a crash, an evicted isolate) is resumed from its last SAVED row, the way a run
 * paused on a rate limit is (`rate-limit-pause.ts`). This is the pure half: what a dead run left behind, and whether
 * it may be resumed. The mutation that acts on the answer is `streaming/persistent/interrupted.ts`.
 *
 * A step that finished is saved, so it is never run again. The step that was in flight is lost: its model call may have
 * been billed (the gateway records usage per call), and the re-run is a new call. A TOOL in flight is different: it may
 * have paid or changed something and leaves no row, so a run that died inside one is never resumed.
 */

/** A reply is resumed at most this many times after its worker died; the next interruption fails the run. */
export const MAX_INTERRUPTION_RESUMES = 3;

/** The run beats this often while it lives. A beat re-runs the live stream query for every viewer, so it is not faster. */
export const RUN_BEAT_MS = 60 * 1000;

/** A claimed run with no beat for this long is dead (several beats missed, well inside the stream's 20 minute expiry). */
export const RUN_STALE_MS = 3 * 60 * 1000;

/** How often the watchdog looks at a run. */
export const RUN_WATCH_MS = 60 * 1000;

/** A row of the thread that the run saved since its stream began, as far as this decision reads it. */
export interface SavedRow {
    /** The row holds an assistant tool call. */
    callsTools: boolean;
    /** No content: the placeholder a step opens before its model call. */
    empty: boolean;
    id: string;
    order: number;
    role: string | undefined;
    status: string;
    stepOrder: number;
}

export type SavedRun =
    | {
          /** The row the resume continues from (the last saved row), or `undefined` for the prompt. */
          from: string | undefined;
          ok: true;
          /** Empty placeholders the dead step left behind: they go before the resume opens its own. */
          placeholders: string[];
          /** Every row the run saved, in order. */
          replyRowIds: string[];
          /** Model steps that finished. */
          stepsUsed: number;
      }
    | { ok: false; reason: "tool_call_without_result" | "unsettled_row" };

const inOrder = (a: SavedRow, b: SavedRow): number => a.order - b.order || a.stepOrder - b.stepOrder;

/**
 * What the dead run saved. Anything that is not a finished row or an empty placeholder cannot be told apart from work
 * in progress, and a trailing tool call without its result would be answered twice by a resume: both refuse.
 */
export const settleSavedRows = (rows: ReadonlyArray<SavedRow>): SavedRun => {
    const ordered = rows.toSorted(inOrder);
    const placeholders = ordered.filter((row) => row.empty && (row.status === "pending" || row.status === "failed"));
    const saved = ordered.filter((row) => !placeholders.includes(row));

    if (saved.some((row) => row.status !== "success")) {
        return { ok: false, reason: "unsettled_row" };
    }

    const last = saved.at(-1);

    if (last?.role === "assistant" && last.callsTools) {
        return { ok: false, reason: "tool_call_without_result" };
    }

    return {
        from: last?.id,
        ok: true,
        placeholders: placeholders.map((row) => row.id),
        replyRowIds: saved.map((row) => row.id),
        stepsUsed: saved.filter((row) => row.role === "assistant").length,
    };
};

export type InterruptionRefusal = "steered" | "too_many_interruptions" | "tool_in_flight" | "tool_call_without_result" | "unsettled_row";

export type InterruptionPlan = { action: "fail"; reason: InterruptionRefusal } | { action: "resume" } | { action: "wait" };

/** Whether a claimed, unpaused run is dead, and if so whether it may be resumed. */
export const planInterruption = (input: {
    beatAt: number;
    interruptions: number;
    now: number;
    saved: SavedRun;
    steerDelivered: boolean;
    toolsInFlight: number;
}): InterruptionPlan => {
    if (input.now - input.beatAt < RUN_STALE_MS) {
        return { action: "wait" };
    }

    if (input.interruptions >= MAX_INTERRUPTION_RESUMES) {
        return { action: "fail", reason: "too_many_interruptions" };
    }

    if (input.toolsInFlight > 0) {
        return { action: "fail", reason: "tool_in_flight" };
    }

    // A steered message was delivered into the run: the resume would put its rows under the wrong prompt (as for a pause).
    if (input.steerDelivered) {
        return { action: "fail", reason: "steered" };
    }

    if (!input.saved.ok) {
        return { action: "fail", reason: input.saved.reason };
    }

    return { action: "resume" };
};

/** The error line a failed run shows, worded for the person. */
export const interruptionMessage = (reason: InterruptionRefusal): string => {
    switch (reason) {
        case "too_many_interruptions": {
            return `The run was interrupted ${MAX_INTERRUPTION_RESUMES} times and resumed each time, so it stopped. Send your message again to retry.`;
        }
        case "tool_in_flight": {
            return "The run was interrupted while a tool was running, so it was not resumed: the tool may already have acted. Check the result, then send your message again to retry.";
        }
        default: {
            return "The run was interrupted and could not be resumed safely. Send your message again to retry.";
        }
    }
};
