/**
 * The rules for messages typed while a coding agent's turn runs (coding-workbench.md 2.3). The backend takes one prompt
 * at a time (`turn_running`), so the composer holds the rest and sends them in order, each once the previous turn has
 * ended. Pure, so the order and the pause rules are tested without rendering the composer.
 *
 * The queue is one state machine (`stepHostQueue`). Its phase says what the composer is waiting for:
 *
 *   loading ──observed──▶ idle ◀──────────────────────────────┐
 *                          │ send                             │ the awaited turn's end
 *                          ▼                                  │
 *                       sending ──accepted / refused (turn running)──▶ awaiting-turn-end
 *                          │ refused
 *                          ▼
 *                         idle (paused)
 *
 *   any phase ──interrupt──▶ awaiting-stop ──stop answered AND that turn's end seen──▶ idle (interrupting message released)
 *
 * Only `idle` sends, one message at a time, and a message the backend took is never posted again. A turn's end is the
 * session's `lastEndStreamId` changing, which names the stream that ended: the stream query clearing, or a stop's answer
 * alone, never lets the next message go.
 */

import type { CapabilityReport } from "@neore/ai/capabilities";
import { followUpControl } from "@neore/ai/capabilities";

/**
 * A host turn's follow-up. The stored report cannot say "restart", because the agent itself never accepts a prompt
 * during a turn: the composer ends the running turn and sends the queued text first, and it enforces that here, so
 * the declaration is ours (provider-capabilities.md §5, the static declarations). Never a model or agent name.
 */
const HOST_FOLLOW_UP_REPORT: CapabilityReport = {
    groups: { turns: { followUp: { degradation: "restart", kind: "steer" } } },
    reportedAt: 0,
    version: 1,
};

/** Whether the composer offers "Interrupt and send" (the restart steer), through the same gate every steer control uses. */
export const canInterruptAndSend = (): boolean => followUpControl(HOST_FOLLOW_UP_REPORT) === "steer-restart";

/** How a turn ended when it did not finish: the queue behind it waits for the person rather than starting on its own. */
const ENDED_UNFINISHED: ReadonlySet<string> = new Set(["failed", "interrupted", "revoked", "timeout"]);

/** Ended by a stop: one from elsewhere (another tab, a device, the computer) pauses the queue; this composer's own does not. */
const ENDED_BY_STOP: ReadonlySet<string> = new Set(["cancelled", "stopped"]);

const unfinished = (reason: string | undefined): boolean => reason !== undefined && ENDED_UNFINISHED.has(reason);

/** Whether a turn that ended with `reason`, and was not stopped by this composer's own Interrupt, leaves the queue paused. */
const endPausesQueue = (reason: string | undefined): boolean => reason !== undefined && (ENDED_UNFINISHED.has(reason) || ENDED_BY_STOP.has(reason));

/** A turn's end as the session reports it: the stream that ended and why. */
export interface HostTurnEnd {
    reason: string | undefined;
    streamId: string;
}

/** What `cancelHostTurn` answered, or `undefined` when the call failed. */
export type HostStopOutcome = { cancelled: boolean; delivered?: boolean; reason?: "no_turn" | "other_turn" } | undefined;

export type HostQueuePhase =
    /** The session and the stream have not both answered since the composer mounted: nothing is known, nothing sends. */
    | { kind: "loading" }
    /** No turn is live and none is awaited: the head may go. */
    | { kind: "idle" }

    /**
     * A message is being posted (`itemId` is unset for a direct send). `seenLive` holds the turns seen running since it began;
     * `endedDuring` is set when one of THOSE turns ended, so an older turn's late end is never taken for this send's own.
     */
    | { endedDuring: boolean; itemId: string | undefined; kind: "sending"; seenLive: ReadonlyArray<string> }
    /** A turn runs, or a send was accepted and its turn has not shown yet (`streamId` unset): only that turn's end releases the queue. */
    | { kind: "awaiting-turn-end"; streamId: string | undefined }

    /**
     * Interrupt and send: `itemId` waits at the head until BOTH the stop is confirmed (`stopConfirmed`) and the stopped
     * turn's end is seen (`ended`, the reason; `null` until then).
     */
    | { ended: string | null | undefined; itemId: string; kind: "awaiting-stop"; stopConfirmed: boolean; streamId: string | undefined; wasPaused: boolean };

export interface HostQueueState {
    /** The reads have answered once since the composer mounted; the first answer is the arrival. */
    arrived: boolean;
    /** The newest turn end seen, so a repeat of the same observation is not a second end. */
    lastEnd: string | undefined;
    /** The turn live now, as last observed. */
    live: string | undefined;
    phase: HostQueuePhase;
    /** The interrupting message, allowed past a queue that stays paused for the messages behind it. */
    released: string | undefined;
    /** Streams known to have ended whose end has not been observed yet: their end must not release a later turn's wait. */
    retired: ReadonlyArray<string>;
    /** Queued messages the backend took. Never posted again, even while the store still shows them. */
    sent: ReadonlyArray<string>;
    /** Streams the session itself has reported live: once it has, a session read without one means that stream ended. */
    sessionSeen: ReadonlyArray<string>;
}

export const INITIAL_HOST_QUEUE: HostQueueState = Object.freeze({
    arrived: false,
    lastEnd: undefined,
    live: undefined,
    phase: { kind: "loading" },
    released: undefined,
    retired: [],
    sent: [],
    sessionSeen: [],
}) as HostQueueState;

export type HostQueueEffect =
    /** Hold what is queued (the composer skips it for an empty queue: a pause would hold the next message typed). */
    | { type: "pause" }
    /** Lift the pause. */
    | { type: "resume" }

    /**
     * Tell the person why a message did not go. For a queued message (`itemId`) that is still queued, the queue also pauses, so
     * it waits at the head for Send next; one that left the queue meanwhile (delivered by another composer) pauses nothing.
     */
    | { error: string; itemId: string | undefined; type: "send-refused" }
    | { itemId: string; type: "stop-failed" | "stop-undelivered" };

export type HostQueueEvent =
    /**
     * The session and stream reads, whenever they change. `live` is the turn running now (either read may show it first),
     * `sessionLive` the session's own report of it, read in the same snapshot as `end`, the newest turn that ended.
     */
    | { end: HostTurnEnd | undefined; live: string | undefined; sessionLive?: string; starting: boolean; type: "observed" }
    | { itemId: string | undefined; type: "send" }
    | { itemId: string | undefined; type: "accepted" }
    /** `live` is the turn the backend reports running after a fresh read, for a `turn_running` refusal. */
    | { error: string; itemId: string | undefined; live: string | undefined; type: "refused" }
    | { itemId: string; streamId: string | undefined; type: "interrupt"; wasPaused: boolean }
    | { outcome: HostStopOutcome; type: "stop-answered" }
    /** The person pressed Stop. */
    | { type: "stopped" }
    /** A queued message was edited, and took a new id. */
    | { from: string; to: string; type: "edited" }
    /** A wait that has a deadline ran out (`waitDeadline`). */
    | { type: "timed-out" };

export interface HostQueueStep {
    effects: HostQueueEffect[];
    state: HostQueueState;
}

const SENT_KEPT = 20;

const remember = (list: ReadonlyArray<string>, id: string | undefined): ReadonlyArray<string> =>
    id === undefined || list.includes(id) ? list : [...list, id].slice(-SENT_KEPT);

/** A stream whose end was seen, or is known to have come: it is not live, whatever a lagging read still says. */
const isOver = (state: HostQueueState, streamId: string): boolean => streamId === state.lastEnd || state.retired.includes(streamId);

/** The turn live now, unless the read that names it lags behind that turn's known end. */
const liveNow = (state: HostQueueState, live: string | undefined): string | undefined => (live === undefined || isOver(state, live) ? undefined : live);

/** Waits for `live` to end when a turn is live, and is idle otherwise. */
const waitFor = (live: string | undefined): HostQueuePhase => (live === undefined ? { kind: "idle" } : { kind: "awaiting-turn-end", streamId: live });

/** Marks a stream as ended whose end has not been seen: arriving later, it decides the pause but releases no wait. */
const retire = (state: HostQueueState, streamId: string | undefined): HostQueueState =>
    streamId === undefined || isOver(state, streamId) ? state : { ...state, retired: remember(state.retired, streamId) };

/**
 * The awaited turn ended without its end being shown. The session names only the newest ended stream, so when two turns
 * overlap and the newer one ends first, the older one's end never shows. The session also names only the newest LIVE
 * stream, so the awaited one dropping out of that is no end; a session read with no live turn at all, after the session
 * has reported the awaited one live, is. It is retired, so a lagging stream read cannot revive it.
 */
const leftSession = (state: HostQueueState, sessionLive: string | undefined): HostQueueState => {
    const { phase } = state;

    if (phase.kind !== "awaiting-turn-end" || phase.streamId === undefined || sessionLive !== undefined || !state.sessionSeen.includes(phase.streamId)) {
        return state;
    }

    return { ...retire(state, phase.streamId), live: state.live === phase.streamId ? undefined : state.live, phase: { kind: "idle" } };
};

/** The stopped turn is over and the stop reached the computer: the interrupting message goes next. */
const finishInterrupt = (state: HostQueueState, phase: Extract<HostQueuePhase, { kind: "awaiting-stop" }>, reason: string | undefined): HostQueueStep => {
    // The stopped turn is over, even when the reads have not said so yet: an end of it that arrives later releases nothing.
    const settled = phase.ended === null ? retire(state, phase.streamId) : state;
    const live = liveNow(settled, settled.live);

    return {
        // A queue that was paused before the interrupt, or a turn that ended unfinished meanwhile, keeps the messages behind it held.
        effects: !phase.wasPaused && !unfinished(reason) ? [{ type: "resume" }] : [],
        state: { ...settled, live, phase: waitFor(live), released: phase.itemId },
    };
};

/** A turn end observed for the first time. */
const onEnd = (state: HostQueueState, end: HostTurnEnd): HostQueueStep => {
    const { phase } = state;
    const next: HostQueueState = { ...state, lastEnd: end.streamId, retired: state.retired.filter((id) => id !== end.streamId) };
    const wasRetired = state.retired.includes(end.streamId);
    // A retired stream's end is late: the turn was already settled as over, by this composer's own stop or by the session
    // showing no turn live. Only a failure pauses for it; its stop was decided when it was retired.
    const pauses = wasRetired ? unfinished(end.reason) : endPausesQueue(end.reason);

    if (phase.kind === "awaiting-stop" && (phase.streamId === undefined || phase.streamId === end.streamId)) {
        // The stopped turn's own end: a `stopped` reason is this Interrupt's, so it pauses nothing. An unfinished one is kept,
        // so the messages behind the interrupting one stay held.
        const waiting = { ...phase, ended: end.reason };

        if (phase.stopConfirmed) {
            return finishInterrupt(next, waiting, end.reason);
        }

        return { effects: unfinished(end.reason) ? [{ type: "pause" }] : [], state: { ...next, phase: waiting } };
    }

    if (
        phase.kind === "awaiting-turn-end" &&
        !wasRetired &&
        (phase.streamId === undefined || phase.streamId === end.streamId || phase.streamId !== state.live)
    ) {
        // The awaited turn ended (or the turn it waited for is no longer live, and only the newest end is reported).
        return { effects: pauses ? [{ type: "pause" }] : [], state: { ...next, phase: { kind: "idle" } } };
    }

    // A send in flight notes the end, unless it is of a turn already known to be over: the send's answer then decides whether
    // its own turn came and went.
    if (phase.kind === "sending" && !wasRetired && phase.seenLive.includes(end.streamId)) {
        return { effects: pauses ? [{ type: "pause" }] : [], state: { ...next, phase: { ...phase, endedDuring: true } } };
    }

    // Any other end: another tab's turn, an older turn, or one known to be over. Its reason still decides whether what is
    // queued waits for the person.
    return { effects: pauses ? [{ type: "pause" }] : [], state: next };
};

/** What a new observation does on top of any end it carried: a live turn is noted by a send, and awaited otherwise. */
const onLive = (step: HostQueueStep, live: string | undefined): HostQueueStep => {
    const { effects, state: next } = step;
    const { phase } = next;

    if (live === undefined) {
        return step;
    }

    // A send in flight notes the turns it sees running: only their ends can be its own turn's.
    if (phase.kind === "sending") {
        return { effects, state: phase.seenLive.includes(live) ? next : { ...next, phase: { ...phase, seenLive: [...phase.seenLive, live] } } };
    }

    // A turn that runs is awaited until it ends, whoever started it.
    const awaitsNothing = phase.kind === "idle" || (phase.kind === "awaiting-turn-end" && phase.streamId === undefined);

    return { effects, state: awaitsNothing ? { ...next, phase: waitFor(live) } : next };
};

const onObserved = (state: HostQueueState, event: Extract<HostQueueEvent, { type: "observed" }>): HostQueueStep => {
    const { end, starting } = event;

    if (!state.arrived) {
        // The arrival: an end from before the composer mounted was never seen happening, so it is checked once here, and it is
        // the baseline later ends are told from. A session that is starting is a new agent: the previous turn's end says nothing
        // about the messages queued for it. A direct send made before the reads answered keeps its phase, and like any other
        // phase it takes in a turn the arrival shows running.
        const arrived: HostQueueState = { ...state, arrived: true, lastEnd: end?.streamId, sessionSeen: remember(state.sessionSeen, event.sessionLive) };
        const live = liveNow(arrived, event.live);

        return onLive(
            {
                effects: live === undefined && !starting && endPausesQueue(end?.reason) ? [{ type: "pause" }] : [],
                state: { ...arrived, live, phase: state.phase.kind === "loading" ? { kind: "idle" } : state.phase },
            },
            live,
        );
    }

    const isNewEnd = end !== undefined && end.streamId !== state.lastEnd;
    const ended = isNewEnd ? onEnd({ ...state, live: liveNow({ ...state, lastEnd: end.streamId }, event.live) }, end) : { effects: [], state };
    const settled = leftSession(ended.state, event.sessionLive);
    const live = liveNow(settled, event.live);

    return onLive({ effects: ended.effects, state: { ...settled, live, sessionSeen: remember(settled.sessionSeen, event.sessionLive) } }, live);
};

const onStopAnswered = (state: HostQueueState, outcome: HostStopOutcome): HostQueueStep => {
    const { phase } = state;

    // A stop answered after the person pressed Stop, or after the turn moved on, has nothing left to decide.
    if (phase.kind !== "awaiting-stop") {
        return { effects: [], state };
    }

    if (outcome?.cancelled === true && outcome.delivered !== false) {
        const confirmed = { ...phase, stopConfirmed: true };

        // The stop is confirmed, but the turn's end must be seen too: until then the stream may still be writing.
        return phase.ended === null ? { effects: [], state: { ...state, phase: confirmed } } : finishInterrupt(state, confirmed, phase.ended);
    }

    if (outcome?.reason === "no_turn") {
        // The turn had already ended on its own. If its end has not been seen yet, it is retired: arriving later, it decides
        // the pause by its reason but cannot be taken for the end of the turn the interrupting message starts.
        if (phase.ended !== null) {
            return finishInterrupt(state, phase, phase.ended);
        }

        return finishInterrupt(state, phase, undefined);
    }

    // Not stopped, another turn is live, the call failed, or the stream ended without the computer being told: the agent may
    // still be running, so the interrupting message stays held at the head for the person.
    return {
        effects: [{ itemId: phase.itemId, type: outcome?.cancelled === true ? "stop-undelivered" : "stop-failed" }],
        state: {
            ...state,
            phase: waitFor(liveNow(state, state.live)),
            released: undefined,
        },
    };
};

/** The queue's transitions. Every change of the queue's phase goes through here. */
export const stepHostQueue = (state: HostQueueState, event: HostQueueEvent): HostQueueStep => {
    const { phase } = state;

    switch (event.type) {
        case "accepted": {
            if (phase.kind !== "sending") {
                return { effects: [], state };
            }

            const sent = event.itemId === undefined ? state.sent : [...state.sent, event.itemId].slice(-SENT_KEPT);
            const live = liveNow(state, state.live);
            let next: HostQueuePhase;

            if (live !== undefined) {
                next = waitFor(live);
            } else if (phase.endedDuring) {
                // The turn started and ended while the answer was in flight; its end was decided when it was seen.
                next = { kind: "idle" };
            } else {
                next = { kind: "awaiting-turn-end", streamId: undefined };
            }

            return { effects: [], state: { ...state, phase: next, sent } };
        }
        case "edited": {
            const rename = (id: string | undefined): string | undefined => (id === event.from ? event.to : id);
            const next: HostQueuePhase = phase.kind === "awaiting-stop" ? { ...phase, itemId: rename(phase.itemId) ?? phase.itemId } : phase;

            return { effects: [], state: { ...state, phase: next, released: rename(state.released) } };
        }
        case "interrupt": {
            // The turn may have ended already, and that end been seen: then only the stop's answer is missing.
            const ended = event.streamId !== undefined && event.streamId === state.lastEnd ? undefined : null;

            return {
                effects: [{ type: "pause" }],
                state: {
                    ...state,
                    phase: { ended, itemId: event.itemId, kind: "awaiting-stop", stopConfirmed: false, streamId: event.streamId, wasPaused: event.wasPaused },
                    released: undefined,
                },
            };
        }
        case "observed": {
            return onObserved(state, event);
        }
        case "refused": {
            if (phase.kind !== "sending") {
                return { effects: [], state };
            }

            if (event.error === "turn_running") {
                // Another tab's turn got there first. A queued message waits for that turn's end, without a pause: it is not
                // posted again before then. A direct send was never queued, so the person is told; the text stays in the box.
                const live = liveNow(state, event.live);
                const told: HostQueueEffect[] = event.itemId === undefined ? [{ error: event.error, itemId: undefined, type: "send-refused" }] : [];

                if (live !== undefined) {
                    return { effects: told, state: { ...state, live, phase: waitFor(live) } };
                }

                // That turn has ended since: its end was observed, so the message may go again.
                if (phase.endedDuring) {
                    return { effects: told, state: { ...state, phase: { kind: "idle" } } };
                }
            }

            // A refused queued message waits at the head for the person: the composer pauses the queue for it, if it is still queued.
            return { effects: [{ error: event.error, itemId: event.itemId, type: "send-refused" }], state: { ...state, phase: { kind: "idle" } } };
        }
        case "send": {
            // One send at a time, and a queued one only from idle. A direct send may go before the reads have answered, as the
            // backend refuses it if a turn runs.
            if (phase.kind !== "idle" && (phase.kind !== "loading" || event.itemId !== undefined)) {
                return { effects: [], state };
            }

            return {
                effects: [],
                state: {
                    ...state,
                    phase: { endedDuring: false, itemId: event.itemId, kind: "sending", seenLive: [] },
                    released: event.itemId !== undefined && event.itemId === state.released ? undefined : state.released,
                },
            };
        }
        case "stop-answered": {
            return onStopAnswered(state, event.outcome);
        }
        case "stopped": {
            // A Stop holds everything, the interrupting message too. An interrupt still waiting waits now for its turn's end
            // alone; one whose stop was confirmed, or whose end was seen, has nothing left to wait for.
            if (phase.kind !== "awaiting-stop") {
                return { effects: [{ type: "pause" }], state: { ...state, released: undefined } };
            }

            const settled = phase.stopConfirmed && phase.ended === null ? retire(state, phase.streamId) : state;
            const over = phase.ended !== null || phase.stopConfirmed || phase.streamId === undefined;
            const next: HostQueuePhase = over ? waitFor(liveNow(settled, settled.live)) : { kind: "awaiting-turn-end", streamId: phase.streamId };

            return { effects: [{ type: "pause" }], state: { ...settled, phase: next, released: undefined } };
        }
        case "timed-out": {
            // An accepted send whose turn never showed: the queue waits for the person rather than guessing.
            if (phase.kind === "awaiting-turn-end" && phase.streamId === undefined) {
                return { effects: [{ type: "pause" }], state: { ...state, phase: { kind: "idle" } } };
            }

            // A confirmed stop whose end never showed: the stop said the turn is over.
            if (phase.kind === "awaiting-stop" && phase.stopConfirmed && phase.ended === null) {
                return finishInterrupt(state, phase, undefined);
            }

            return { effects: [], state };
        }
        default: {
            return { effects: [], state };
        }
    }
};

/** Whether `streamId`, as a read shows it, is a turn still running: not one whose end the machine has already seen. */
export const isTurnLive = (state: HostQueueState, streamId: string | undefined): boolean => liveNow(state, streamId) !== undefined;

/** Whether the phase waits on an event that may never come, so the composer arms a deadline (`timed-out`). */
export const waitDeadline = (phase: HostQueuePhase): boolean =>
    (phase.kind === "awaiting-turn-end" && phase.streamId === undefined) || (phase.kind === "awaiting-stop" && phase.stopConfirmed && phase.ended === null);

/**
 * Whether the composer still holds the thread's drain lock: from a send until its turn has shown, so another tab that
 * gets the lock next finds the turn running.
 */
export const holdsDrainLock = (phase: HostQueuePhase): boolean =>
    phase.kind === "sending" || (phase.kind === "awaiting-turn-end" && phase.streamId === undefined);

/** A message typed now waits behind the queue when a turn runs or is awaited, the session is starting, or messages are queued. */
export const shouldQueueMessage = (state: { phase: HostQueuePhase; queued: number; running: boolean; starting: boolean }): boolean =>
    state.running || state.starting || state.queued > 0 || (state.phase.kind !== "idle" && state.phase.kind !== "loading");

/**
 * Whether the queue's head may be sent now: only from `idle`, only a message not already taken, never while the queue is
 * paused (unless it is the released interrupting message), a turn runs, the session is ended or starting, or the head's
 * editor is open.
 */
export const canSendQueueHead = (
    state: HostQueueState,
    gates: { blocked: boolean; editing: boolean; headId: string | undefined; paused: boolean; running: boolean; starting: boolean },
): boolean =>
    gates.headId !== undefined &&
    state.phase.kind === "idle" &&
    !state.sent.includes(gates.headId) &&
    (!gates.paused || gates.headId === state.released) &&
    !gates.blocked &&
    !gates.starting &&
    !gates.running &&
    !gates.editing;
