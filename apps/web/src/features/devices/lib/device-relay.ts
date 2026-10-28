/**
 * The page's half of device execution: a
 * RELAY between the backend's pending calls and the desktop shell. It claims a
 * call (claim-once, so a second window never runs it twice), hands the signed
 * envelope to the shell and sends the shell's signed result back. It decides
 * nothing: the shell verifies the envelope and asks the user in its own window.
 */
import type { NativeSigned } from "@/lib/native/bridge";

/** Mirrors `DEVICE_ONLINE_WINDOW_MS` in `backend/lunora/devices/lib/constants.ts`. */
export const DEVICE_ONLINE_WINDOW_MS = 75_000;

/** How often the shell's page reports the device as online. */
export const DEVICE_HEARTBEAT_MS = 30_000;

export interface PendingDeviceCall {
    callId: string;
    envelope: string;
    signature: string;
}

export interface DeviceRelayPorts {
    claim: (callId: string) => Promise<boolean>;
    complete: (callId: string, result: NativeSigned) => Promise<void>;
    execute: (call: PendingDeviceCall) => Promise<NativeSigned>;
    /** The shell refused the envelope itself: fail the call now rather than at its deadline. */
    release: (callId: string, reason: string) => Promise<void>;
}

export type DeviceRelayOutcome = "completed" | "not-claimed" | "refused";

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Retries start here and double, with jitter, up to the cap: a backend that failed for one relay is failing for the others. */
const RETRY_START_MS = 500;
const RETRY_MAX_MS = 15_000;
/** A call with no deadline in its envelope is retried for as long as the backend keeps one (`DEVICE_CALL_DEADLINE_MS`). */
const FALLBACK_DEADLINE_MS = 5 * 60_000;
/** A call another window holds is looked at again after this: its claim may lapse and come back to the queue. */
const NOT_CLAIMED_COOLDOWN_MS = 15_000;

export interface RelayClock {
    now: () => number;
    random: () => number;
    sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: RelayClock = {
    now: () => Date.now(),
    random: () => Math.random(),
    sleep: async (ms) => {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    },
};

/** When the call's own envelope says it is over. The page only reads it to know how long to keep trying; the shell verifies it. */
const deadlineOf = (call: PendingDeviceCall, now: number): number => {
    try {
        const parsed = JSON.parse(call.envelope) as { expiresAt?: unknown };

        return typeof parsed.expiresAt === "number" ? parsed.expiresAt : now + FALLBACK_DEADLINE_MS;
    } catch {
        return now + FALLBACK_DEADLINE_MS;
    }
};

/** Attempts at one step. With the backoff cap this is a few minutes, well inside a call's deadline, and bounds what retries spend of the relay's rate limit. */
const MAX_ATTEMPTS = 20;

/** The backend's answers that the same request will get again: not allowed, malformed, not there. A reset or a 5xx is not among them. */
const PERMANENT_CODES: ReadonlySet<unknown> = new Set(["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED", "UNPROCESSABLE"]);

const isPermanent = (error: unknown): boolean => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return PERMANENT_CODES.has(code) || PERMANENT_CODES.has(data?.code);
};

/**
 * Runs one step against the backend and tries it again until the call's deadline, whatever the transient error. A
 * retry that covered one status or one kind of failure would strand a call on the next kind: a server error, then
 * a network reset, is two different failures and the call still has to get through. An answer that cannot change
 * (a bad signature is FORBIDDEN, a malformed result BAD_REQUEST) is not retried, and neither is a step past
 * {@link MAX_ATTEMPTS}. The last error is thrown.
 */
const untilDeadline = async <T>(step: () => Promise<T>, deadline: number, clock: RelayClock): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await step();
        } catch (error) {
            if (clock.now() >= deadline || attempt + 1 >= MAX_ATTEMPTS || isPermanent(error)) {
                throw error;
            }

            const wait = Math.min(RETRY_MAX_MS, RETRY_START_MS * 2 ** Math.min(attempt, 10)) * (0.5 + clock.random() * 0.5);

            const remaining = Math.max(0, deadline - clock.now());

             
            await clock.sleep(Math.min(wait, remaining));
        }
    }
};

export const relayDeviceCall = async (call: PendingDeviceCall, ports: DeviceRelayPorts, clock: RelayClock = REAL_CLOCK): Promise<DeviceRelayOutcome> => {
    const deadline = deadlineOf(call, clock.now());

    if (!(await untilDeadline(async () => await ports.claim(call.callId), deadline, clock))) {
        return "not-claimed";
    }

    let result: NativeSigned;

    try {
        result = await ports.execute(call);
    } catch (error) {
        await untilDeadline(async () => await ports.release(call.callId, reasonOf(error)), deadline, clock);

        return "refused";
    }

    await untilDeadline(async () => await ports.complete(call.callId, result), deadline, clock);

    return "completed";
};

/**
 * Relays each call once at a time, however often the live query re-sends the pending list. A call that finishes is
 * forgotten: one that comes back (a claim that lapsed returns the call to the queue) is relayed again, and the
 * shell acknowledges a command it already received instead of running it twice. Calls run concurrently; the shell
 * queues their prompts.
 */
export const createDeviceRelay = (ports: DeviceRelayPorts, onError: (error: unknown) => void = () => {}, clock: RelayClock = REAL_CLOCK) => {
    const inFlight = new Set<string>();
    const coolingUntil = new Map<string, number>();

    const relayOne = async (call: PendingDeviceCall): Promise<void> => {
        try {
            if ((await relayDeviceCall(call, ports, clock)) === "not-claimed") {
                coolingUntil.set(call.callId, clock.now() + NOT_CLAIMED_COOLDOWN_MS);
            }
        } catch (error) {
            onError(error);
        } finally {
            inFlight.delete(call.callId);
        }
    };

    return (calls: ReadonlyArray<PendingDeviceCall>): void => {
        for (const call of calls) {
            if (inFlight.has(call.callId) || (coolingUntil.get(call.callId) ?? 0) > clock.now()) {
                continue;
            }

            inFlight.add(call.callId);
            relayOne(call);
        }
    };
};

export const isDeviceOnline = (lastSeenAt: number | undefined, now: number): boolean => lastSeenAt !== undefined && now - lastSeenAt <= DEVICE_ONLINE_WINDOW_MS;
