/**
 * The `SchedulerDO` namespace, scoped to the calling shard.
 *
 * Two upstream gaps meet here (docs/plans/per-user-sharding.md, "Scheduler
 * serialization"):
 *
 * 1. The generated app builds `createScheduler({ namespace })` with no
 *    `instanceName`, so every job in the app goes to ONE `SchedulerDO`
 *    (`idFromName("default")`). Since `@lunora/scheduler@alpha.79` its alarm
 *    drains with up to six dispatches in flight (anolilab/lunora#793), but six
 *    lanes and one 15-minute alarm budget still serve the whole app, so one
 *    user's slow jobs still queue everyone else's behind the sixth.
 * 2. `runAfter`/`runAt` still never default `shardKey` (alpha.79), so without
 *    this a job scheduled from a user's shard is dispatched to `__root__`,
 *    where none of that user's rows live. THIS is the part correctness needs;
 *    the per-user instance below is isolation.
 *
 * The namespace selector handed to `.scheduler(...)` is the one seam the
 * builder exposes, so both are fixed by wrapping the binding:
 *
 * - a `/schedule` request that names no `shardKey` gets the calling shard's;
 * - a `/schedule` for a USER shard goes to that user's own instance,
 *   `shard:<userId>` — one scheduler lane per user instead of one per app,
 *   including for jobs the root cron fans out to each user;
 * - `idFromName("default")` from inside a user shard (`cancel`, `get`) resolves
 *   that shard's instance, which is where its own jobs went.
 *
 * Outside a user shard (the cron tick on `__root__`, an HTTP action, the studio)
 * a job for `__root__` stays on the default instance. `cancel`/`get` find a job
 * when they run on the shard the job TARGETS — every call site here cancels
 * its own shard's jobs.
 *
 * Workpools (`createWorkpool`) are not routed here: a pooled job's `/complete`
 * goes to the instance named in its record, and a record enqueued through the
 * default name carries none. Nothing in the app uses one; long work runs on the
 * jobs queue instead.
 */
import { currentUserShard, ROOT_SHARD_KEY } from "./shard-context";

interface StubLike {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

interface NamespaceLike {
    get: (id: never, ...rest: never[]) => StubLike;
    getByName?: (name: string, ...rest: never[]) => StubLike;
    idFromName: (name: string) => unknown;
    jurisdiction?: (jurisdiction: never) => NamespaceLike;
}

/** The instance name `createScheduler` uses when it is given none. */
const DEFAULT_INSTANCE = "default";

/** The `SchedulerDO` instance a user shard's jobs go to. */
export const schedulerInstanceFor = (shardKey: string): string => `shard:${shardKey}`;

const instanceName = (name: string, shardKey: string | undefined): string =>
    name === DEFAULT_INSTANCE && shardKey !== undefined ? schedulerInstanceFor(shardKey) : name;

const requestPath = (input: Request | string): string => {
    try {
        return new URL(typeof input === "string" ? input : input.url).pathname;
    } catch {
        return "";
    }
};

/**
 * A `/schedule` request, with `shardKey` defaulted to the calling shard's, and
 * the shard the job will run on — or `undefined` when this is not a `/schedule`
 * the wrapper understands. Only a plain JSON string body is read (what
 * `@lunora/scheduler`'s `callDO` sends); anything else passes through untouched
 * rather than being guessed at.
 */
export const routeSchedule = (
    input: Request | string,
    init: RequestInit | undefined,
    callingShard: string | undefined,
): { init: RequestInit | undefined; targetShard: string | undefined } | undefined => {
    if (typeof init?.body !== "string" || !requestPath(input).endsWith("/schedule")) {
        return undefined;
    }

    let body: unknown;

    try {
        body = JSON.parse(init.body);
    } catch {
        return undefined;
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return undefined;
    }

    const payload = body as { shardKey?: unknown };

    if (typeof payload.shardKey === "string" && payload.shardKey.length > 0) {
        return { init, targetShard: payload.shardKey === ROOT_SHARD_KEY ? undefined : payload.shardKey };
    }

    if (callingShard === undefined) {
        return { init, targetShard: undefined };
    }

    return { init: { ...init, body: JSON.stringify({ ...payload, shardKey: callingShard }) }, targetShard: callingShard };
};

/**
 * The request as `(url, init)` with a string body. `@lunora/scheduler` calls
 * `fetch(url, init)`; the runtime's HTTP-action scheduler passes a `Request`,
 * whose body is read here so both shapes route the same way.
 */
const normalizeRequest = async (
    input: Request | string,
    init: RequestInit | undefined,
): Promise<{ init: RequestInit | undefined; input: Request | string }> => {
    if (typeof input === "string" || init !== undefined || input.method !== "POST" || !requestPath(input).endsWith("/schedule")) {
        return { init, input };
    }

    return { init: { body: await input.clone().text(), headers: input.headers, method: input.method }, input: input.url };
};

const wrapStub = (target: NamespaceLike, stub: StubLike, readShard: () => string | undefined): StubLike => {
    return {
        fetch: async (rawInput, rawInit) => {
            // Read BEFORE any await below: the calling shard is the async context's.
            const callingShard = readShard();
            const { init, input } = await normalizeRequest(rawInput, rawInit);
            const routed = routeSchedule(input, init, callingShard);

            if (routed === undefined) {
                return await stub.fetch(rawInput, rawInit);
            }

            // The job's lane is its TARGET shard's instance, whoever schedules it.
            const lane = routed.targetShard === undefined ? stub : target.get(target.idFromName(schedulerInstanceFor(routed.targetShard)) as never);

            return await lane.fetch(input, routed.init);
        },
    };
};

/**
 * Wrap a `SchedulerDO` namespace binding so it routes by the calling shard.
 * `readShard` is injectable for tests; production reads the ALS shard context.
 */
export const shardScopedSchedulerNamespace = <N extends object>(namespace: N, readShard: () => string | undefined = currentUserShard): N => {
    const target = namespace as unknown as NamespaceLike;

    return new Proxy(namespace, {
        get(object, property) {
            if (property === "idFromName") {
                return (name: string) => target.idFromName(instanceName(name, readShard()));
            }

            if (property === "get") {
                return (id: never, ...rest: never[]) => wrapStub(target, target.get(id, ...rest), readShard);
            }

            if (property === "getByName" && typeof target.getByName === "function") {
                const getByName = target.getByName.bind(target);

                return (name: string, ...rest: never[]) => wrapStub(target, getByName(instanceName(name, readShard()), ...rest), readShard);
            }

            if (property === "jurisdiction" && typeof target.jurisdiction === "function") {
                const jurisdiction = target.jurisdiction.bind(target);

                return (value: never) => shardScopedSchedulerNamespace(jurisdiction(value), readShard);
            }

            const value: unknown = Reflect.get(object, property);

            // Native binding methods need their own receiver (workerd rejects a
            // detached call with "Illegal invocation").
            return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(object) : value;
        },
    });
};

/**
 * `ctx.scheduler.runAfter` onto a NAMED shard. The runtime forwards a fourth
 * `{ shardKey }` argument (see `routeSchedule` above) but `@lunora/server`'s
 * `Scheduler` type declares three, so the one cast lives here.
 */
export const runAfterOnShard = async <A extends Record<string, unknown>>(
    scheduler: unknown,
    delayMs: number,
    target: { __lunoraRef: string },
    args: A,
    shardKey: string,
): Promise<string> =>
    await (scheduler as { runAfter: (delay: number, target: unknown, args: A, options: { shardKey: string }) => Promise<string> }).runAfter(
        delayMs,
        target,
        args,
        { shardKey },
    );
