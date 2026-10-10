/**
 * DEV-ONLY request timing, for finding where a request waits before its
 * handler starts (docs/plans/per-user-sharding.md, "Measurements").
 *
 * `SHARD_TIMING=on` in `backend/.dev.vars` logs one `[timing]` JSON line per
 * stage, each carrying the path and milliseconds:
 *
 * - `worker` — Worker entry to response, with the time spent before
 *   `app.fetch` (identity + default shard) as `routeMs`;
 * - `do` — a shard Durable Object's `fetch`, entry to response, with how many
 *   requests were already in flight in that DO when it arrived;
 * - `d1` — any D1 statement or batch slower than {@link SLOW_D1_MS}, with
 *   whether it was the first D1 call of its Worker request / DO request.
 *
 * Off (the default) it costs one property read per request. Honoured only when
 * `ENVIRONMENT` is `development`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TimingEnv {
    ENVIRONMENT?: string;
    SHARD_TIMING?: string;
}

/** A D1 call slower than this is logged. */
export const SLOW_D1_MS = 100;

export const isTimingEnabled = (env: TimingEnv): boolean => env.SHARD_TIMING === "on" && env.ENVIRONMENT === "development";

interface Frame {
    d1Calls: number;
    label: string;
}

const frames = new AsyncLocalStorage<Frame>();

export const logTiming = (stage: string, fields: Record<string, unknown>): void => {
    console.log(`[timing] ${JSON.stringify({ stage, ...fields })}`);
};

/** Run `work` as one timed frame; D1 calls inside it count against it. */
export const inTimingFrame = async <T>(label: string, work: () => Promise<T>): Promise<T> => await frames.run({ d1Calls: 0, label }, work);

const timeD1Call = async <T>(kind: string, call: () => Promise<T>): Promise<T> => {
    const frame = frames.getStore();
    const first = frame !== undefined && frame.d1Calls === 0;

    if (frame) {
        frame.d1Calls += 1;
    }

    const started = Date.now();

    try {
        return await call();
    } finally {
        const ms = Date.now() - started;

        if (ms >= SLOW_D1_MS) {
            logTiming("d1", { first, frame: frame?.label ?? "none", kind, ms });
        }
    }
};

const EXECUTORS = new Set(["all", "first", "raw", "run"]);

const wrapStatement = (statement: object): object =>
    new Proxy(statement, {
        get(target, property) {
            const value: unknown = Reflect.get(target, property);

            if (typeof value !== "function") {
                return value;
            }

            const bound = (value as (...arguments_: unknown[]) => unknown).bind(target);

            if (property === "bind") {
                return (...arguments_: unknown[]) => wrapStatement(bound(...arguments_) as object);
            }

            if (typeof property === "string" && EXECUTORS.has(property)) {
                return async (...arguments_: unknown[]) => await timeD1Call(property, async () => await (bound(...arguments_) as Promise<unknown>));
            }

            return bound;
        },
    });

const timedDatabases = new WeakMap<object, object>();

/**
 * `db`, with every statement and batch timed — the SAME wrapper for the same
 * binding every time: Lunora keys per-isolate state (the lazily created
 * `.global()` tables) on the D1 object, so a fresh wrapper per request would
 * re-run that setup on every request and measure the instrument, not the app.
 */
export const timedD1 = <D extends object>(db: D): D => {
    const cached = timedDatabases.get(db);

    if (cached) {
        return cached as D;
    }

    const wrapped = createTimedD1(db);

    timedDatabases.set(db, wrapped);

    return wrapped;
};

const createTimedD1 = <D extends object>(db: D): D =>
    new Proxy(db, {
        get(target, property) {
            const value: unknown = Reflect.get(target, property);

            if (typeof value !== "function") {
                return value;
            }

            const bound = (value as (...arguments_: unknown[]) => unknown).bind(target);

            if (property === "prepare") {
                return (...arguments_: unknown[]) => wrapStatement(bound(...arguments_) as object);
            }

            if (property === "batch" || property === "exec") {
                return async (...arguments_: unknown[]) => await timeD1Call(property, async () => await (bound(...arguments_) as Promise<unknown>));
            }

            return bound;
        },
    });

let fetchTimingInstalled = false;

const urlOf = (input: Parameters<typeof fetch>[0]): string => {
    if (typeof input === "string") {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
};

/**
 * Time every outbound `fetch` of this isolate: one slower than
 * {@link SLOW_D1_MS} is logged with its path and the frame that made it, which
 * is what shows a Durable Object waiting on a loopback call to its own Worker.
 */
export const installFetchTiming = (): void => {
    if (fetchTimingInstalled) {
        return;
    }

    fetchTimingInstalled = true;

    const original = fetch.bind(globalThis);

    // Patching the isolate's `fetch` IS the instrument: it is the one seam every
    // outbound call passes through. Dev-only, installed once, behind SHARD_TIMING.
    // eslint-disable-next-line unicorn/no-global-object-property-assignment
    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        const started = Date.now();
        const frame = frames.getStore();

        try {
            return await original(input, init);
        } finally {
            const ms = Date.now() - started;

            if (ms >= SLOW_D1_MS) {
                let path = urlOf(input);

                try {
                    const parsed = new URL(path);

                    path = `${parsed.host}${parsed.pathname}`;
                } catch {
                    // keep the raw value
                }

                logTiming("fetch", { frame: frame?.label ?? "none", ms, path });
            }
        }
    };
};
