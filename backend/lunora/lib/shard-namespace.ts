/**
 * The `SHARD` Durable Object namespace, with a DEV-ONLY switch that sends every
 * shard key to `__root__` (docs/plans/per-user-sharding.md, "Measurements").
 *
 * `SHARD_ROUTING=off` in `backend/.dev.vars` makes the stack behave as it did
 * before per-user sharding — one Durable Object for everything — while running
 * the same code, so an A/B on one stack under one load isolates what the
 * routing itself costs. It maps the namespace, not each caller: the Worker's
 * default shard, `forShard(...)`, `createShardClient`, the queue's and the
 * scheduler's `shardKey` all resolve their DO through here, so all of them
 * land on `__root__`, and inside it `ctx.id.name` is `__root__`, so the shard
 * context (`lib/shard-context.ts`) reads "root" too. What it does NOT undo is
 * the table tiering: tables moved to `.global()` stay in D1.
 *
 * Honoured only when `ENVIRONMENT` is `development`. Anywhere else, preview
 * included, collapsing every user onto one DO would put new rows where nothing
 * reads them once routing is back.
 */
import { ROOT_SHARD_KEY } from "./shard-context";

export interface ShardRoutingEnv {
    ENVIRONMENT?: string;
    SHARD_ROUTING?: string;
}

/** Whether per-user shard routing is on. Only `SHARD_ROUTING=off` in development turns it off. */
export const isShardRoutingEnabled = (env: ShardRoutingEnv): boolean => {
    if (env.SHARD_ROUTING !== "off") {
        return true;
    }

    if (env.ENVIRONMENT !== "development") {
        console.error(`[shards] SHARD_ROUTING=off is honoured only in development (ENVIRONMENT=${String(env.ENVIRONMENT)}); per-user routing stays on`);

        return true;
    }

    return false;
};

interface NamespaceLike {
    getByName?: (name: string, ...rest: never[]) => unknown;
    idFromName: (name: string) => unknown;
    jurisdiction?: (jurisdiction: never) => unknown;
}

const collapse = <N extends object>(namespace: N): N => {
    const target = namespace as unknown as NamespaceLike;

    return new Proxy(namespace, {
        get(object, property) {
            if (property === "idFromName") {
                return () => target.idFromName(ROOT_SHARD_KEY);
            }

            if (property === "getByName" && typeof target.getByName === "function") {
                const getByName = target.getByName.bind(target);

                return (_name: string, ...rest: never[]) => getByName(ROOT_SHARD_KEY, ...rest);
            }

            if (property === "jurisdiction" && typeof target.jurisdiction === "function") {
                const jurisdiction = target.jurisdiction.bind(target);

                return (value: never) => collapse(jurisdiction(value) as object);
            }

            const value: unknown = Reflect.get(object, property);

            // Native binding methods need their own receiver (workerd rejects a
            // detached call with "Illegal invocation").
            return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(object) : value;
        },
    });
};

const collapsed = new WeakMap<object, object>();

/**
 * `namespace`, or — with routing switched off in dev — the same namespace pinned
 * to `__root__`. One wrapper per binding: the runtime may key per-isolate state
 * on the namespace object, and a fresh wrapper per request would defeat it.
 */
export const routedShardNamespace = <N extends object>(namespace: N, env: ShardRoutingEnv): N => {
    if (isShardRoutingEnabled(env)) {
        return namespace;
    }

    const cached = collapsed.get(namespace);

    if (cached) {
        return cached as N;
    }

    const wrapped = collapse(namespace);

    collapsed.set(namespace, wrapped);

    return wrapped;
};
