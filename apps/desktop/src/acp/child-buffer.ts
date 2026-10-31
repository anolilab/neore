/**
 * The measurement behind the child buffer's byte budget (plans/acp-s7-children.md): replays an agent's recorded
 * `session/update`s through the ledger the session uses and reports how many bytes of child events waited for a parent
 * call that had not appeared, at the most, per session.
 */
import { childEventOf, childParentOf, isRecord, text } from "./child-updates";
import { ChildLedger } from "./children";

export interface ChildBufferMeasure {
    /** Child events seen, held or not. */
    childEvents: number;
    /** Events that did not fit the budget. */
    dropped: number;
    /** The most bytes held at once. */
    peakBytes: number;
}

/** `updates` are the `params.update` objects of one session's `session/update` notifications, in order. */
export const measureChildBuffer = (updates: Record<string, unknown>[], budgetBytes?: number): ChildBufferMeasure => {
    const ledger = new ChildLedger({ budgetBytes, emit: () => undefined, scrub: (value) => value, secretLength: 0 });
    const seen = new Set<string>();
    let childEvents = 0;

    for (const update of updates) {
        const parent = childParentOf(update);

        if (parent === undefined) {
            const id = text(update.toolCallId);

            // The first sight of a tool call is what makes its card.
            if (id !== "" && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && !seen.has(id)) {
                seen.add(id);
                ledger.spawn(id);
            }

            continue;
        }

        const event = childEventOf(update, (value) => value);

        if (event !== undefined) {
            childEvents += 1;
            ledger.receive(parent, event);
        }
    }

    ledger.discardUnclaimed();

    return { childEvents, ...ledger.stats() };
};

/** The `session/update` updates in a log of the agent's output, one JSON-RPC frame per line, grouped by the agent's session id. */
export const updatesBySession = (log: string): Map<string, Record<string, unknown>[]> => {
    const sessions = new Map<string, Record<string, unknown>[]>();

    for (const line of log.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        let frame: unknown;

        try {
            frame = JSON.parse(line);
        } catch {
            continue;
        }

        if (!isRecord(frame) || frame.method !== "session/update" || !isRecord(frame.params) || !isRecord(frame.params.update)) {
            continue;
        }

        const sessionId = text(frame.params.sessionId);

        sessions.set(sessionId, [...sessions.get(sessionId) ?? [], frame.params.update]);
    }

    return sessions;
};
