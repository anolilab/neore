/**
 * Messages that reach this computer before their session is open (plans/acp-agent-host.md §4.6).
 *
 * A phone can send just after it started a session, and the relay can claim the `acp_send` before the `acp_start`
 * it follows. The command is acknowledged once its receipt is on disk (`commands.ts`), and is carried out when the
 * session opens:
 *
 * **Held** while the session is starting or not known yet. The turn's channel is opened at once, so the backend
 * shows the turn as received and its reaper keeps hearing from it.
 *
 * **Sent, in the order they arrived,** when the session opens.
 *
 * **Failed with a reason** when the session never opens, when the envelope expires first, or when the turn is
 * cancelled meanwhile: the stream ends with an error, never with silence.
 *
 * A session already open takes the message at once. One that has ended refuses it.
 */
import type { AppliedCall, Held } from "./commands";
import { ACCEPTED, HELD } from "./commands";
import type { SessionObserver } from "./host-events";
import type { SessionStatus } from "./types";

export const NEVER_OPENED = "the agent did not open its session in time, so the message was not sent";
export const NOT_OPEN_HERE = "this session is not open on this computer, so the message was not sent";

/** How long a message waits for a session this computer has not heard of: the start it follows is claimed within moments, or never comes. */
export const UNKNOWN_SESSION_WAIT_MS = 30_000;
/** How long a failed start is remembered for the messages that follow it (a command lives five minutes), and how many are. */
const FAILURE_KEEP_MS = 5 * 60_000;
const MAX_FAILURES = 64;

interface HeldSend {
    callId: string;
    expiresAt: number;
    sessionId: string;
    text: string;
    timer: ReturnType<typeof setTimeout>;
    turnId: string;
}

export interface EarlySendsOptions {
    /** The command's receipt can leave the log: the message was sent, or ended with an error. */
    finished: (callId: string) => void;
    log?: (message: string) => void;
    now?: () => number;
    observer: Pick<SessionObserver, "turnEnded"> & { turnHeld?: (sessionId: string, turnId: string, user: string, threadId: string) => void };
    /** Hands the message to an open session. Throws when it cannot take it. */
    send: (sessionId: string, text: string, turnId: string) => void;
    /** What the manager knows of the session. `undefined`: it has not heard of it (yet). */
    statusOf: (sessionId: string) => SessionStatus | undefined;
}

export class EarlySends {
    private readonly held = new Map<string, HeldSend[]>();

    /** sessionId → why its start failed, for the messages that arrive after it. */
    private readonly failures = new Map<string, { reason: string; until: number }>();

    public constructor(private readonly options: EarlySendsOptions) {}

    /** Sends the message now, or holds it. Throws to refuse one for a session that has ended. */
    public submit(command: { sessionId: string; text: string; turnId: string }, call: AppliedCall): Held | typeof ACCEPTED {
        const { sessionId, text, turnId } = command;
        const status = this.options.statusOf(sessionId);

        if (status === "ended") {
            throw new Error("this session has ended");
        }

        if (status === "idle" || status === "busy") {
            this.options.send(sessionId, text, turnId);

            return ACCEPTED;
        }

        if (call.threadId === undefined) {
            throw new Error("this session is not open yet");
        }

        const failure = status === undefined ? this.failureOf(sessionId) : undefined;

        if (failure !== undefined) {
            throw new Error(`the agent did not start: ${failure}`);
        }

        const wait = Math.max(0, call.expiresAt - this.now());
        const entry: HeldSend = {
            callId: call.callId,
            expiresAt: call.expiresAt,
            sessionId,
            text,
            // A session nobody has heard of is waited for briefly; one that is starting, until the envelope expires.
            timer: setTimeout(() => this.timedOut(entry), status === undefined ? Math.min(wait, UNKNOWN_SESSION_WAIT_MS) : wait),
            turnId,
        };

        entry.timer.unref();
        this.held.set(sessionId, [...this.held.get(sessionId) ?? [], entry]);
        this.options.observer.turnHeld?.(sessionId, turnId, text, call.threadId);

        return HELD;
    }

    /** The session is open: what waited for it goes in, in the order it arrived. */
    public opened(sessionId: string): void {
        const waiting = this.held.get(sessionId) ?? [];

        this.held.delete(sessionId);
        this.failures.delete(sessionId);

        for (const entry of waiting) {
            clearTimeout(entry.timer);

            if (this.now() >= entry.expiresAt) {
                this.end(entry, NEVER_OPENED);

                continue;
            }

            try {
                this.options.send(entry.sessionId, entry.text, entry.turnId);
                this.options.finished(entry.callId);
            } catch (error) {
                this.end(entry, `the agent could not take the message: ${(error as Error).message}`);
            }
        }
    }

    /** The session did not open: every message waiting for it fails with the reason. */
    public failed(sessionId: string, reason: string): void {
        const waiting = this.held.get(sessionId) ?? [];

        this.held.delete(sessionId);
        this.remember(sessionId, reason);

        for (const entry of waiting) {
            clearTimeout(entry.timer);
            this.end(entry, `the agent did not start, so the message was not sent: ${reason}`);
        }
    }

    /** Stop for a turn still held: it is withdrawn and its stream told it was cancelled. */
    public cancel(sessionId: string, turnId: string): boolean {
        const waiting = this.held.get(sessionId) ?? [];
        const index = waiting.findIndex((entry) => entry.turnId === turnId);
        const [entry] = index === -1 ? [] : waiting.splice(index, 1);

        if (entry === undefined) {
            return false;
        }

        this.forgetIfEmpty(sessionId, waiting);
        clearTimeout(entry.timer);
        this.options.observer.turnEnded(sessionId, turnId, "cancelled");
        this.options.finished(entry.callId);

        return true;
    }

    /** Ends a turn that was held and never ran; the one place that tells its stream and clears its receipt. */
    private end(entry: HeldSend, reason: string): void {
        this.options.log?.(`[acp-host] a held message was not sent: ${reason}`);
        this.options.observer.turnEnded(entry.sessionId, entry.turnId, "failed", reason.slice(0, 1000));
        this.options.finished(entry.callId);
    }

    private remember(sessionId: string, reason: string): void {
        const now = this.now();

        for (const [id, { until }] of this.failures) {
            if (until <= now) {
                this.failures.delete(id);
            }
        }

        this.failures.delete(sessionId);
        this.failures.set(sessionId, { reason, until: now + FAILURE_KEEP_MS });

        while (this.failures.size > MAX_FAILURES) {
            this.failures.delete(this.failures.keys().next().value as string);
        }
    }

    private failureOf(sessionId: string): string | undefined {
        const known = this.failures.get(sessionId);

        return known !== undefined && known.until > this.now() ? known.reason : undefined;
    }

    /** The wait is over: a session that appeared meanwhile is waited for until the envelope expires, any other is not open here. */
    private timedOut(entry: HeldSend): void {
        const status = this.options.statusOf(entry.sessionId);
        const remaining = entry.expiresAt - this.now();

        if (status !== undefined && status !== "ended" && remaining > 0) {
            // eslint-disable-next-line no-param-reassign -- the held entry owns its timer, which `opened` and `cancel` clear
            entry.timer = setTimeout(() => this.fail(entry, NEVER_OPENED), remaining);
            entry.timer.unref();

            return;
        }

        this.fail(entry, status === undefined && remaining > 0 ? NOT_OPEN_HERE : NEVER_OPENED);
    }

    private fail(entry: HeldSend, reason: string): void {
        const waiting = this.held.get(entry.sessionId) ?? [];
        const index = waiting.indexOf(entry);

        if (index === -1) {
            return;
        }

        waiting.splice(index, 1);
        this.forgetIfEmpty(entry.sessionId, waiting);
        this.end(entry, reason);
    }

    /** A session with nothing held leaves no key behind. */
    private forgetIfEmpty(sessionId: string, waiting: HeldSend[]): void {
        if (waiting.length === 0) {
            this.held.delete(sessionId);
        }
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }
}
