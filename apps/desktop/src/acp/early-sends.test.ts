/**
 * A message that arrives before its session is open (`early-sends.ts`, plans/acp-agent-host.md §4.6): it runs once
 * when the session opens, and ends its stream with an error when the session never opens, the envelope expires
 * first, or the turn is stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HELD } from "./commands";
import { EarlySends, NEVER_OPENED, NOT_OPEN_HERE, UNKNOWN_SESSION_WAIT_MS } from "./early-sends";
import type { SessionStatus } from "./types";

interface Rig {
    early: EarlySends;
    ended: { error?: string; reason: string; turnId: string }[];
    finished: string[];
    held: { threadId: string; turnId: string; user: string }[];
    sent: { sessionId: string; text: string; turnId: string }[];
    setStatus: (sessionId: string, status: SessionStatus | undefined) => void;
}

const rig = (overrides: { sendFails?: boolean } = {}): Rig => {
    const statuses = new Map<string, SessionStatus>();
    const result: Rig = {
        early: undefined as unknown as EarlySends,
        ended: [],
        finished: [],
        held: [],
        sent: [],
        setStatus: (sessionId, status) => {
            if (status === undefined) {
                statuses.delete(sessionId);
            } else {
                statuses.set(sessionId, status);
            }
        },
    };

    result.early = new EarlySends({
        finished: (callId) => {
            result.finished.push(callId);
        },
        log: () => undefined,
        observer: {
            turnEnded: (_sessionId, turnId, reason, error) => {
                result.ended.push({ turnId, ...error !== undefined && { error }, reason });
            },
            turnHeld: (_sessionId, turnId, user, threadId) => {
                result.held.push({ threadId, turnId, user });
            },
        },
        send: (sessionId, text, turnId) => {
            if (overrides.sendFails === true) {
                throw new Error("8 prompts are already waiting");
            }

            result.sent.push({ sessionId, text, turnId });
        },
        statusOf: (sessionId) => statuses.get(sessionId),
    });

    return result;
};

const call = (callId: string, expiresAt = Date.now() + 60_000) => {
    return { callId, expiresAt, threadId: "t1" };
};
const message = (turnId = "u1") => {
    return { sessionId: "s1", text: "fix it", turnId };
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a message for a session that is not open", () => {
    it("is held while the session is starting, with its turn opened at once, and runs once when it opens", () => {
        const subject = rig();

        subject.setStatus("s1", "starting");

        expect(subject.early.submit(message(), call("c1"))).toBe(HELD);
        expect(subject.held).toEqual([{ threadId: "t1", turnId: "u1", user: "fix it" }]);
        expect(subject.sent).toEqual([]);

        subject.early.opened("s1");
        expect(subject.sent).toEqual([message()]);
        expect(subject.finished).toEqual(["c1"]);

        // Opened again (a restart's replay): nothing is left to run twice.
        subject.early.opened("s1");
        expect(subject.sent).toHaveLength(1);
    });

    it("is held for a session this computer has not heard of yet, as when the send is claimed before the start", () => {
        const subject = rig();

        expect(subject.early.submit(message(), call("c1"))).toBe(HELD);

        subject.setStatus("s1", "idle");
        subject.early.opened("s1");
        expect(subject.sent).toEqual([message()]);
    });

    it("goes in the order it arrived", () => {
        const subject = rig();

        subject.early.submit(message("u1"), call("c1"));
        subject.early.submit(message("u2"), call("c2"));
        subject.early.opened("s1");
        expect(subject.sent.map((entry) => entry.turnId)).toEqual(["u1", "u2"]);
    });

    it("ends its stream with the reason when the session never opens", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1"));
        subject.early.failed("s1", "the agent exited with code 1");

        expect(subject.sent).toEqual([]);
        expect(subject.ended).toEqual([{ error: "the agent did not start, so the message was not sent: the agent exited with code 1", reason: "failed", turnId: "u1" }]);
        expect(subject.finished).toEqual(["c1"]);
    });

    it("ends its stream when its envelope expires before the session opens, and runs nothing after", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1", Date.now() + 30_000));
        vi.advanceTimersByTime(30_001);
        expect(subject.ended).toEqual([{ error: NEVER_OPENED, reason: "failed", turnId: "u1" }]);

        subject.early.opened("s1");
        expect(subject.sent).toEqual([]);
        expect(subject.finished).toEqual(["c1"]);
    });

    it("gives up on a session this computer never heard of after a short wait, not at the envelope's expiry", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1", Date.now() + 5 * 60_000));
        vi.advanceTimersByTime(UNKNOWN_SESSION_WAIT_MS + 1);

        expect(subject.ended).toEqual([{ error: NOT_OPEN_HERE, reason: "failed", turnId: "u1" }]);
        expect(subject.finished).toEqual(["c1"]);
    });

    it("keeps waiting to the envelope's expiry for a session that became known meanwhile", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1", Date.now() + 5 * 60_000));
        subject.setStatus("s1", "starting");
        vi.advanceTimersByTime(UNKNOWN_SESSION_WAIT_MS + 1);
        expect(subject.ended).toEqual([]);

        vi.advanceTimersByTime(5 * 60_000);
        expect(subject.ended).toEqual([{ error: NEVER_OPENED, reason: "failed", turnId: "u1" }]);
    });

    it("refuses at once, with the real reason, a message that follows a start that failed before the session existed", () => {
        const subject = rig();

        subject.early.failed("s1", "that folder is not approved");

        expect(() => subject.early.submit(message(), call("c1"))).toThrow("that folder is not approved");
        expect(subject.held).toEqual([]);

        // A later start of the same session clears it.
        subject.early.opened("s1");
        subject.setStatus("s1", "idle");
        expect(subject.early.submit(message(), call("c2"))).not.toBe(HELD);
    });

    it("forgets a failed start once its envelope lifetime has passed", () => {
        const subject = rig();

        subject.early.failed("s1", "no agent");
        vi.advanceTimersByTime(5 * 60_000 + 1);

        const second = call("c1", Date.now() + 60_000);

        expect(subject.early.submit(message(), second)).toBe(HELD);
    });

    it("ends its stream, not runs, when the session opens after the envelope's expiry", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1", Date.now() + 30_000));
        // A clock that moved without the timer firing (the computer slept).
        vi.setSystemTime(Date.now() + 60_000);
        subject.early.opened("s1");

        expect(subject.sent).toEqual([]);
        expect(subject.ended).toMatchObject([{ reason: "failed", turnId: "u1" }]);
    });

    it("ends its stream with the agent's reason when the session cannot take it", () => {
        const subject = rig({ sendFails: true });

        subject.early.submit(message(), call("c1"));
        subject.early.opened("s1");

        expect(subject.ended).toMatchObject([{ error: expect.stringContaining("already waiting"), reason: "failed" }]);
        expect(subject.finished).toEqual(["c1"]);
    });

    it("is withdrawn by a stop for its turn, and ends cancelled", () => {
        const subject = rig();

        subject.early.submit(message(), call("c1"));

        expect(subject.early.cancel("s1", "other")).toBe(false);
        expect(subject.early.cancel("s1", "u1")).toBe(true);
        expect(subject.ended).toEqual([{ reason: "cancelled", turnId: "u1" }]);

        subject.early.opened("s1");
        expect(subject.sent).toEqual([]);
    });
});

describe("what is held", () => {
    const heldSessions = (subject: Rig): number => (subject.early as unknown as { held: Map<string, unknown> }).held.size;

    it("leaves no key behind for a session once its last message is gone", () => {
        const subject = rig();

        subject.early.submit(message("u1"), call("c1"));
        subject.early.submit({ ...message("u2"), sessionId: "s2" }, call("c2"));
        expect(heldSessions(subject)).toBe(2);

        subject.early.cancel("s1", "u1");
        expect(heldSessions(subject)).toBe(1);

        vi.advanceTimersByTime(61_000);
        expect(heldSessions(subject)).toBe(0);

        subject.early.submit(message("u3"), call("c3"));
        subject.early.opened("s1");
        expect(heldSessions(subject)).toBe(0);
    });
});

describe("a message for a session that is open or over", () => {
    it("is sent at once to an open session, held for none", () => {
        const subject = rig();

        subject.setStatus("s1", "idle");
        expect(subject.early.submit(message(), call("c1"))).toBe("accepted");
        expect(subject.sent).toEqual([message()]);
        expect(subject.held).toEqual([]);
    });

    it("is refused for a session that has ended", () => {
        const subject = rig();

        subject.setStatus("s1", "ended");
        expect(() => subject.early.submit(message(), call("c1"))).toThrow("this session has ended");
    });
});
