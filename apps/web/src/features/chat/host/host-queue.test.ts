import { describe, expect, it } from "vitest";

import type { HostQueueEvent, HostQueueState, HostQueueStep } from "./host-queue";
import {
    canEditQueued,
    canInterruptAndSend,
    canSendQueueHead,
    holdsDrainLock,
    INITIAL_HOST_QUEUE,
    sendNowAction,
    shouldQueueMessage,
    stepHostQueue,
    waitDeadline,
} from "./host-queue";

/** Runs events in order and collects every effect they produced. */
const run = (events: HostQueueEvent[], from: HostQueueState = INITIAL_HOST_QUEUE): HostQueueStep => {
    let step: HostQueueStep = { effects: [], state: from };

    for (const event of events) {
        const next = stepHostQueue(step.state, event);

        step = { effects: [...step.effects, ...next.effects], state: next.state };
    }

    return step;
};

const observed = (live: string | undefined, end?: [string, string]): HostQueueEvent => {
    return { end: end && { reason: end[1], streamId: end[0] }, live, starting: false, type: "observed" };
};

const gates = { blocked: false, editing: false, headId: "a", paused: false, running: false, starting: false };

/** Idle, with turn `stream-0` ended as finished. */
const IDLE = run([observed(undefined, ["stream-0", "finished"])]).state;

/** Turn `stream-1` is running. */
const RUNNING = run([observed("stream-1")], IDLE).state;

const types = (step: HostQueueStep) => step.effects.map((effect) => effect.type);

const effectTypes = (events: HostQueueEvent[], from?: HostQueueState) => types(run(events, from));

describe("queueing a message during a host turn", () => {
    it("queues while a turn runs, while the session starts, and while the queue already holds messages", () => {
        expect(shouldQueueMessage({ phase: IDLE.phase, queued: 0, running: true, starting: false })).toBe(true);
        expect(shouldQueueMessage({ phase: IDLE.phase, queued: 2, running: false, starting: false })).toBe(true);
        expect(shouldQueueMessage({ phase: IDLE.phase, queued: 0, running: false, starting: true })).toBe(true);
    });

    it("queues while a send is in flight or its turn has not shown yet", () => {
        const sending = run([{ itemId: undefined, type: "send" }], IDLE).state;
        const awaiting = run([{ itemId: undefined, type: "accepted" }], sending).state;

        expect(shouldQueueMessage({ phase: sending.phase, queued: 0, running: false, starting: false })).toBe(true);
        expect(shouldQueueMessage({ phase: awaiting.phase, queued: 0, running: false, starting: false })).toBe(true);
    });

    it("sends at once when nothing runs and nothing waits", () => {
        expect(shouldQueueMessage({ phase: IDLE.phase, queued: 0, running: false, starting: false })).toBe(false);
    });

    it("offers interrupt-and-send through the restart steer, which the composer enforces", () => {
        expect(canInterruptAndSend()).toBe(true);
    });
});

describe("sending the head of the queue", () => {
    it("sends nothing before the reads have answered", () => {
        expect(canSendQueueHead(INITIAL_HOST_QUEUE, gates)).toBe(false);
    });

    it("sends the head when the thread is idle", () => {
        expect(canSendQueueHead(IDLE, gates)).toBe(true);
    });

    it("waits while a turn runs, while a send is in flight, and while an accepted send's turn has not shown", () => {
        const sending = run([{ itemId: "a", type: "send" }], IDLE).state;

        expect(canSendQueueHead(RUNNING, gates)).toBe(false);
        expect(canSendQueueHead(IDLE, { ...gates, running: true })).toBe(false);
        expect(canSendQueueHead(sending, gates)).toBe(false);
        expect(canSendQueueHead(run([{ itemId: "a", type: "accepted" }], sending).state, { ...gates, headId: "b" })).toBe(false);
    });

    it("stays put when paused, when the session has ended or is starting, and while the head is being edited", () => {
        expect(canSendQueueHead(IDLE, { ...gates, paused: true })).toBe(false);
        expect(canSendQueueHead(IDLE, { ...gates, blocked: true })).toBe(false);
        expect(canSendQueueHead(IDLE, { ...gates, starting: true })).toBe(false);
        expect(canSendQueueHead(IDLE, { ...gates, editing: true })).toBe(false);
    });

    it("never posts a message the backend already took, even while the store still shows it", () => {
        const step = run([{ itemId: "a", type: "send" }, { itemId: "a", type: "accepted" }, observed(undefined, ["stream-1", "finished"])], IDLE);

        expect(step.state.phase.kind).toBe("idle");
        expect(canSendQueueHead(step.state, gates)).toBe(false);
    });

    it("takes a direct send before the reads have answered, but never a queued one", () => {
        expect(stepHostQueue(INITIAL_HOST_QUEUE, { itemId: undefined, type: "send" }).state.phase.kind).toBe("sending");
        expect(stepHostQueue(INITIAL_HOST_QUEUE, { itemId: "a", type: "send" }).state).toBe(INITIAL_HOST_QUEUE);
    });

    it("takes one send at a time: a second send while one is in flight changes nothing", () => {
        const sending = run([{ itemId: "a", type: "send" }], IDLE).state;

        expect(stepHostQueue(sending, { itemId: "b", type: "send" }).state).toBe(sending);
    });
});

describe("a turn's end", () => {
    it("releases the queue only when the awaited turn's end is seen, not when the turn merely stops showing", () => {
        const accepted = run([{ itemId: "a", type: "send" }, { itemId: "a", type: "accepted" }, observed("stream-1")], IDLE).state;

        expect(accepted.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });
        // The stream no longer shows, but the session has not reported the end yet.
        expect(run([observed(undefined)], accepted).state.phase.kind).toBe("awaiting-turn-end");
        expect(run([observed(undefined, ["stream-1", "finished"])], accepted).state.phase.kind).toBe("idle");
    });

    it("pauses the queue behind a turn that failed, timed out, was revoked or was stopped from elsewhere", () => {
        for (const reason of ["failed", "timeout", "revoked", "interrupted", "stopped", "cancelled"]) {
            expect(effectTypes([observed(undefined, ["stream-1", reason])], RUNNING)).toEqual(["pause"]);
        }
    });

    it("does not pause the queue behind a turn that finished", () => {
        expect(effectTypes([observed(undefined, ["stream-1", "finished"])], RUNNING)).toEqual([]);
    });

    it("counts a repeated observation of the same end once", () => {
        const ended = run([observed(undefined, ["stream-1", "stopped"])], RUNNING).state;

        expect(effectTypes([observed(undefined, ["stream-1", "stopped"])], ended)).toEqual([]);
    });

    it("pauses on arrival for a turn that ended unfinished while the composer was away, unless the session is starting", () => {
        expect(effectTypes([observed(undefined, ["stream-0", "failed"])])).toEqual(["pause"]);
        expect(effectTypes([{ end: { reason: "failed", streamId: "stream-0" }, live: undefined, starting: true, type: "observed" }])).toEqual([]);
    });

    it("pauses the queue for an accepted send whose turn never shows, rather than guessing", () => {
        const accepted = run(
            [
                { itemId: "a", type: "send" },
                { itemId: "a", type: "accepted" },
            ],
            IDLE,
        ).state;

        expect(waitDeadline(accepted.phase)).toBe(true);
        expect(holdsDrainLock(accepted.phase)).toBe(true);

        const step = run([{ type: "timed-out" }], accepted);

        expect(step.state.phase.kind).toBe("idle");
        expect(types(step)).toEqual(["pause"]);
    });

    it("goes idle at once for a turn that started and ended while the send's answer was in flight", () => {
        const step = run(
            [{ itemId: "a", type: "send" }, observed("stream-1"), observed(undefined, ["stream-1", "failed"]), { itemId: "a", type: "accepted" }],
            IDLE,
        );

        expect(step.state.phase.kind).toBe("idle");
        expect(types(step)).toEqual(["pause"]);
    });

    it("does not take a late end of a turn it never saw running for the send's own turn", () => {
        const step = run([{ itemId: undefined, type: "send" }, observed(undefined, ["stream-9", "finished"]), { itemId: undefined, type: "accepted" }], IDLE);

        // The send's turn has not shown yet, so the next message still queues behind it.
        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });
        expect(shouldQueueMessage({ phase: step.state.phase, queued: 0, running: false, starting: false })).toBe(true);
    });
});

describe("reads that disagree", () => {
    it("does not wait for a turn whose end the session already reports, when the stream read still shows it", () => {
        const arrived = run([observed("stream-1", ["stream-1", "finished"])]).state;

        expect(arrived.phase.kind).toBe("idle");
        expect(canSendQueueHead(arrived, gates)).toBe(true);
    });

    it("does not wait for a turn that a running-turn refusal's re-read names, when that turn has already ended", () => {
        const step = run(
            [
                { itemId: "a", type: "send" },
                { error: "turn_running", itemId: "a", live: "stream-0", type: "refused" },
            ],
            IDLE,
        );

        expect(step.state.phase.kind).toBe("idle");
    });

    it("takes in a turn the first reads show running, for a direct send made before they answered", () => {
        const accepted = run([
            { itemId: undefined, type: "send" },
            { itemId: undefined, type: "accepted" },
        ]).state;
        const arrived = run([observed("stream-1")], accepted).state;

        // The send's turn is known, so no deadline runs while it does, and only its end releases the queue.
        expect(arrived.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });
        expect(waitDeadline(arrived.phase)).toBe(false);

        const inFlight = run([{ itemId: undefined, type: "send" }, observed("stream-1"), { itemId: undefined, type: "accepted" }]).state;

        expect(inFlight.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });
    });

    it("treats the first reads after a direct send made before they answered as the arrival, not as a new end", () => {
        const step = run(
            [
                { itemId: undefined, type: "send" },
                { end: { reason: "failed", streamId: "stream-0" }, live: undefined, starting: true, type: "observed" },
                { itemId: undefined, type: "accepted" },
            ],
            INITIAL_HOST_QUEUE,
        );

        // The old failure is before this composer, and the session is starting: nothing pauses, and the send still waits for its turn.
        expect(types(step)).toEqual([]);
        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });
    });
});

describe("overlapping turns", () => {
    const seen = (sessionLive: string | undefined, end?: [string, string]): HostQueueEvent => {
        return { end: end && { reason: end[1], streamId: end[0] }, live: sessionLive, sessionLive, starting: false, type: "observed" };
    };

    it("does not take an older turn that is still running for ended when a newer one is reported live", () => {
        const step = run([seen("stream-1"), seen("stream-2")], IDLE);

        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });
    });

    it("goes on once no turn is live, when the newer turn ended first and the older one's end never shows", () => {
        // Turn 2 is the newest live turn; it ends first, then turn 1 (still running) is awaited. Turn 1's end is never the
        // session's newest end, which stays turn 2.
        const waiting = run([seen("stream-1"), seen("stream-2"), seen("stream-1", ["stream-2", "finished"])], IDLE).state;

        expect(waiting.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });

        const step = run([seen(undefined, ["stream-2", "finished"])], waiting);

        expect(step.state.phase.kind).toBe("idle");
        expect(canSendQueueHead(step.state, gates)).toBe(true);
        // A stream read that still shows turn 1 does not revive it.
        expect(run([observed("stream-1", ["stream-2", "finished"])], step.state).state.phase.kind).toBe("idle");
    });
});

describe("an accepted send that names its turn", () => {
    it("waits for that turn alone, and is not released by another turn's late end before it shows", () => {
        const step = run(
            [{ itemId: "a", type: "send" }, { itemId: "a", streamId: "stream-5", type: "accepted" }, observed(undefined, ["stream-4", "finished"])],
            IDLE,
        );

        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-5" });
        expect(waitDeadline(step.state.phase)).toBe(false);
        expect(run([observed(undefined, ["stream-5", "finished"])], step.state).state.phase.kind).toBe("idle");
    });

    it("goes idle at once for a repeat whose earlier turn has already ended, rather than waiting and pausing", () => {
        const step = run(
            [
                { itemId: "a", type: "send" },
                { duplicate: true, itemId: "a", streamId: "stream-old", type: "accepted" },
            ],
            IDLE,
        );

        expect(step.state.phase.kind).toBe("idle");
        expect(step.effects).toEqual([]);
    });

    it("waits for a repeat's turn when that turn is the one running", () => {
        const running = run([observed("stream-1")], IDLE).state;
        const step = run([{ duplicate: true, itemId: undefined, streamId: "stream-1", type: "accepted" }], {
            ...running,
            phase: { endedDuring: false, itemId: undefined, kind: "sending", seenLive: [] },
        });

        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-1" });
    });
});

describe("a refused send", () => {
    it("reports why, for the composer to pause the queue behind it", () => {
        const step = run(
            [
                { itemId: "a", type: "send" },
                { error: "unreachable", itemId: "a", live: undefined, type: "refused" },
            ],
            IDLE,
        );

        expect(step.state.phase.kind).toBe("idle");
        expect(step.effects).toEqual([{ error: "unreachable", itemId: "a", type: "send-refused" }]);
    });

    it("reports a refused direct send without pausing the queue", () => {
        const step = run(
            [
                { itemId: undefined, type: "send" },
                { error: "offline", itemId: undefined, live: undefined, type: "refused" },
            ],
            IDLE,
        );

        expect(types(step)).toEqual(["send-refused"]);
    });

    // Qodo: "A refused queued message is re-sent while the stream is re-read".
    it("is not posted again when refused as a running turn: it waits for that turn's end, without a pause", () => {
        const step = run(
            [
                { itemId: "a", type: "send" },
                { error: "turn_running", itemId: "a", live: "stream-2", type: "refused" },
            ],
            IDLE,
        );

        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-2" });
        expect(step.effects).toEqual([]);
        expect(canSendQueueHead(step.state, gates)).toBe(false);
        const ended = run([observed(undefined, ["stream-2", "finished"])], step.state).state;

        expect(canSendQueueHead(ended, gates)).toBe(true);
    });

    it("tells the person when a direct send is refused because another tab's turn started, and waits for that turn", () => {
        const step = run(
            [
                { itemId: undefined, type: "send" },
                { error: "turn_running", itemId: undefined, live: "stream-2", type: "refused" },
            ],
            IDLE,
        );

        expect(step.effects).toEqual([{ error: "turn_running", itemId: undefined, type: "send-refused" }]);
        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-2" });
    });

    it("may go again when the running turn that refused it has been seen ending meanwhile", () => {
        const step = run(
            [
                { itemId: "a", type: "send" },
                observed("stream-2"),
                observed(undefined, ["stream-2", "finished"]),
                { error: "turn_running", itemId: "a", live: undefined, type: "refused" },
            ],
            IDLE,
        );

        expect(step.state.phase.kind).toBe("idle");
        expect(step.effects).toEqual([]);
    });
});

describe("interrupt and send", () => {
    const interrupt = (wasPaused = false): HostQueueEvent => {
        return { itemId: "x", streamId: "stream-1", type: "interrupt", wasPaused };
    };
    const confirmed: HostQueueEvent = { outcome: { cancelled: true, delivered: true }, type: "stop-answered" };
    const headX = { ...gates, headId: "x", paused: true };

    it("holds the interrupting message until the stop is settled", () => {
        const stopping = run([interrupt()], RUNNING).state;

        expect(canSendQueueHead(stopping, headX)).toBe(false);
    });

    it("sends the interrupting message once the stop is confirmed and the turn's end is seen, and lifts the pause", () => {
        const step = run([interrupt(), confirmed, observed(undefined, ["stream-1", "stopped"])], RUNNING);

        expect(step.state.phase.kind).toBe("idle");
        expect(types(step)).toEqual(["pause", "resume"]);
        expect(canSendQueueHead(step.state, headX)).toBe(true);
    });

    // Qodo: "Interrupting text can go out before the stop is confirmed".
    it("does not send the interrupting message when the turn's end arrives before the stop's answer", () => {
        const ended = run([interrupt(), observed(undefined, ["stream-1", "stopped"])], RUNNING).state;

        expect(canSendQueueHead(ended, headX)).toBe(false);

        // The answer then says the stop never reached the computer: the message stays held, with the reason.
        const undelivered = run([{ outcome: { cancelled: true, delivered: false }, type: "stop-answered" }], ended);

        expect(canSendQueueHead(undelivered.state, headX)).toBe(false);
        expect(undelivered.effects).toEqual([{ itemId: "x", type: "stop-undelivered" }]);

        // A stop whose call failed in transport holds it too.
        const failed = run([{ outcome: undefined, type: "stop-answered" }], ended);

        expect(canSendQueueHead(failed.state, headX)).toBe(false);
        expect(failed.effects).toEqual([{ itemId: "x", type: "stop-failed" }]);
    });

    // Qodo: "Interrupt and send can pause the queued messages behind it".
    it("does not take its own stop for a stop from elsewhere, whatever order the answer and the end arrive in", () => {
        expect(effectTypes([interrupt(), observed(undefined, ["stream-1", "stopped"]), confirmed], RUNNING)).toEqual(["pause", "resume"]);
        expect(effectTypes([interrupt(), confirmed, observed(undefined, ["stream-1", "stopped"])], RUNNING)).toEqual(["pause", "resume"]);
    });

    // Qodo: "Externally stopped turns send queued text".
    it("pauses the queue for a later turn stopped from elsewhere after the interrupting message went out", () => {
        const sent = run(
            [
                interrupt(),
                confirmed,
                observed(undefined, ["stream-1", "stopped"]),
                { itemId: "x", type: "send" },
                { itemId: "x", type: "accepted" },
                observed("stream-2"),
            ],
            RUNNING,
        ).state;

        expect(sent.phase).toEqual({ kind: "awaiting-turn-end", streamId: "stream-2" });

        const step = run([observed(undefined, ["stream-2", "stopped"])], sent);

        expect(types(step)).toEqual(["pause"]);
        expect(canSendQueueHead(step.state, { ...gates, headId: "y", paused: true })).toBe(false);
    });

    // Qodo: "Earlier failures hold later follow-ups".
    it("lets the messages behind it go when the turn it stopped finished, even though an earlier turn failed", () => {
        const afterFailure = run([observed(undefined, ["stream-0", "failed"]), observed("stream-1")]).state;
        const step = run([interrupt(), confirmed, observed(undefined, ["stream-1", "stopped"])], afterFailure);

        expect(types(step)).toEqual(["pause", "resume"]);
    });

    // Qodo: "A failed reply can release the held queue".
    it("keeps the messages behind it held when the turn failed while the stop was in flight and the stop then found no turn", () => {
        const step = run(
            [interrupt(), observed(undefined, ["stream-1", "failed"]), { outcome: { cancelled: false, reason: "no_turn" }, type: "stop-answered" }],
            RUNNING,
        );

        expect(types(step)).toEqual(["pause", "pause"]);
        expect(step.effects).not.toContainEqual({ type: "resume" });
        // The interrupting message itself still goes: the person asked for it, and no turn runs.
        expect(canSendQueueHead(step.state, headX)).toBe(true);
    });

    it("keeps them held when that failure arrives only after the no-turn answer, and does not take it for the next turn's end", () => {
        const released = run(
            [
                interrupt(),
                { outcome: { cancelled: false, reason: "no_turn" }, type: "stop-answered" },
                { itemId: "x", type: "send" },
                { itemId: "x", type: "accepted" },
            ],
            RUNNING,
        );

        expect(released.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });

        const late = run([observed(undefined, ["stream-1", "failed"])], released.state);

        expect(types(late)).toEqual(["pause"]);
        expect(late.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });
    });

    it("keeps a queue that was paused before the interrupt paused, and releases only the interrupting message", () => {
        const step = run([interrupt(true), confirmed, observed(undefined, ["stream-1", "stopped"])], RUNNING);

        expect(types(step)).toEqual(["pause"]);
        expect(canSendQueueHead(step.state, headX)).toBe(true);
        expect(canSendQueueHead(run([{ itemId: "x", type: "send" }], step.state).state, { ...headX, headId: "y" })).toBe(false);
    });

    it("holds the interrupting message when the person presses Stop after it", () => {
        const step = run([interrupt(), { type: "stopped" }, confirmed, observed(undefined, ["stream-1", "stopped"])], RUNNING);

        expect(step.state.released).toBeUndefined();
        expect(canSendQueueHead(step.state, headX)).toBe(false);
    });

    it("follows the interrupting message through an edit, which gives it a new id", () => {
        const step = run([interrupt(), { from: "x", to: "x2", type: "edited" }, confirmed, observed(undefined, ["stream-1", "stopped"])], RUNNING);

        expect(canSendQueueHead(step.state, { ...headX, headId: "x2" })).toBe(true);
    });

    it("goes on after a confirmed stop whose end never shows, and takes that end, arriving late, for no other turn's", () => {
        const waiting = run([interrupt(), confirmed], RUNNING).state;

        expect(waitDeadline(waiting.phase)).toBe(true);

        const released = run([{ type: "timed-out" }], waiting).state;

        expect(canSendQueueHead(released, headX)).toBe(true);

        // The interrupting message goes, and its turn has not shown when the stopped turn's end finally arrives.
        const sent = run(
            [
                { itemId: "x", type: "send" },
                { itemId: "x", type: "accepted" },
            ],
            released,
        ).state;
        const late = run([observed(undefined, ["stream-1", "stopped"])], sent);

        expect(late.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });
    });

    it("does not pause the messages behind it for its own stop's end, arriving after the deadline let them go", () => {
        const released = run([interrupt(), confirmed, { type: "timed-out" }], RUNNING);

        expect(types(released)).toEqual(["pause", "resume"]);

        const late = run([observed(undefined, ["stream-1", "stopped"])], released.state);

        expect(types(late)).toEqual([]);
        // A late failure of that turn still holds them.
        expect(effectTypes([observed(undefined, ["stream-1", "failed"])], released.state)).toEqual(["pause"]);
    });

    it("does not take a stopped turn's late end, arriving while the interrupting message is sent, for that message's turn", () => {
        const step = run(
            [
                interrupt(),
                { outcome: { cancelled: false, reason: "no_turn" }, type: "stop-answered" },
                { itemId: "x", type: "send" },
                observed(undefined, ["stream-1", "failed"]),
                { itemId: "x", type: "accepted" },
            ],
            RUNNING,
        );

        expect(step.state.phase).toEqual({ kind: "awaiting-turn-end", streamId: undefined });
        expect(holdsDrainLock(step.state.phase)).toBe(true);
    });

    it("leaves a Stop after a confirmed interrupt with nothing to wait for, rather than a wait with no deadline", () => {
        const step = run([interrupt(), confirmed, { type: "stopped" }], RUNNING);

        expect(step.state.phase.kind).toBe("idle");
        expect(step.state.released).toBeUndefined();
    });
});

describe("editing a queued message", () => {
    it("cannot edit the message being sent, nor one the backend took, and can edit the rest", () => {
        const sending = run([{ itemId: "a", type: "send" }], IDLE).state;
        const taken = run([{ itemId: "a", streamId: "stream-2", type: "accepted" }], sending).state;

        expect(canEditQueued(IDLE, "a")).toBe(true);
        expect(canEditQueued(sending, "a")).toBe(false);
        expect(canEditQueued(sending, "b")).toBe(true);
        expect(canEditQueued(taken, "a")).toBe(false);
    });
});

describe("Send now", () => {
    it("interrupts a running turn, and sends next with no turn running", () => {
        expect(sendNowAction(RUNNING, { itemId: "b", running: true, tried: false })).toBe("interrupt");
        expect(sendNowAction(IDLE, { itemId: "b", running: false, tried: false })).toBe("release");
    });

    it("waits while a send or a stop is in flight, before the reads answer, and while an accepted send's turn has not shown", () => {
        const sending = run([{ itemId: "a", type: "send" }], IDLE).state;
        const unseen = run([{ itemId: "a", type: "accepted" }], sending).state;
        const stopping = run([{ itemId: "a", streamId: "stream-1", type: "interrupt", wasPaused: false }], RUNNING).state;

        expect(sendNowAction(INITIAL_HOST_QUEUE, { itemId: "b", running: false, tried: false })).toBeUndefined();
        // A direct send refused before the reads answered leaves the phase idle, but nothing is known yet.
        const refusedEarly = run([
            { itemId: undefined, type: "send" },
            { error: "busy", itemId: undefined, live: undefined, type: "refused" },
        ]).state;

        expect(refusedEarly.phase.kind).toBe("idle");
        expect(sendNowAction(refusedEarly, { itemId: "b", running: false, tried: false })).toBeUndefined();
        expect(sendNowAction(sending, { itemId: "b", running: false, tried: false })).toBeUndefined();
        expect(sendNowAction(unseen, { itemId: "b", running: false, tried: false })).toBeUndefined();
        expect(sendNowAction(stopping, { itemId: "b", running: true, tried: false })).toBeUndefined();
    });

    it("does not stop a turn for a message whose send may have been taken, and sends it next once no turn runs", () => {
        // That turn may be its own lost-answer send: a resend under its id would be a duplicate of the stopped turn.
        expect(sendNowAction(RUNNING, { itemId: "a", running: true, tried: true })).toBeUndefined();
        expect(sendNowAction(IDLE, { itemId: "a", running: false, tried: true })).toBe("release");
    });

    it("holds a released message again when a turn from elsewhere starts and fails between two reads", () => {
        const released = run([{ itemId: "b", type: "released" }], IDLE).state;
        const step = run([observed(undefined, ["stream-other", "failed"])], released);

        expect(types(step)).toEqual(["pause"]);
        expect(step.state.released).toBeUndefined();
    });

    it("holds a released message again when a turn from elsewhere starts before it went", () => {
        const released = run([{ itemId: "b", type: "released" }], IDLE).state;

        expect(run([observed("stream-other")], released).state.released).toBeUndefined();
    });

    it("sends the message past a paused queue once, and keeps the rest paused", () => {
        const released = run([{ itemId: "b", type: "released" }], IDLE).state;
        const paused = { ...gates, headId: "b", paused: true };

        expect(canSendQueueHead(released, paused)).toBe(true);
        // Only the released message goes: the one behind it still waits for the person.
        expect(canSendQueueHead(released, { ...paused, headId: "a" })).toBe(false);

        const sent = run(
            [{ itemId: "b", type: "send" }, { itemId: "b", streamId: "stream-2", type: "accepted" }, observed(undefined, ["stream-2", "finished"])],
            released,
        ).state;

        expect(sent.phase.kind).toBe("idle");
        expect(canSendQueueHead(sent, paused)).toBe(false);
        expect(sendNowAction(sent, { itemId: "b", running: false, tried: false })).toBeUndefined();
        expect(run([{ itemId: "b", type: "released" }], sent).state.released).toBeUndefined();
    });
});
