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

        const wait = Math.max(0, call.expiresAt - this.now());
        const entry: HeldSend = {
            callId: call.callId,
            expiresAt: call.expiresAt,
            sessionId,
            text,
            timer: setTimeout(() => this.fail(entry, NEVER_OPENED), wait),
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
