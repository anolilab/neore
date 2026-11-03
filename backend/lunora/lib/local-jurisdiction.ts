/**
 * Local dev runs on workerd, which does not implement Durable Object
 * jurisdictions: `namespace.jurisdiction("eu")` throws "Jurisdiction
 * restrictions are not implemented in workerd", so a schema pinned to the EU
 * would answer every request with a 500 under `lunora dev`. Where there is no
 * jurisdiction to honour, the namespace is its own jurisdiction.
 *
 * Only when `ENVIRONMENT` is exactly `development`, like the other dev-only
 * switches (`SHARD_ROUTING`). A deployed Worker never reaches this.
 */

interface JurisdictionNamespace {
    jurisdiction?: (jurisdiction: never) => unknown;
}

export interface LocalJurisdictionEnv {
    ENVIRONMENT?: string;
    SCHEDULER?: unknown;
    SHARD?: unknown;
    SHARD_REGISTRY?: unknown;
}

const shim = (namespace: unknown): void => {
    if (typeof namespace !== "object" || namespace === null) {
        return;
    }

    // The class prototype, not the binding: a Durable Object, a service-bound entrypoint and
    // the Worker each hold their own `env`, and the namespaces in all of them share it.
    const prototype = Object.getPrototypeOf(namespace) as JurisdictionNamespace | null;

    if (prototype === null || prototype === Object.prototype || typeof prototype.jurisdiction !== "function") {
        return;
    }

    Object.defineProperty(prototype, "jurisdiction", {
        configurable: true,
        value(this: unknown) {
            return this;
        },
        writable: true,
    });
};

/**
 * Makes `jurisdiction()` on the Durable Object namespaces return the namespace itself, in
 * development only. Call it once at module scope with the global `env`: every entry point
 * (fetch, queue, scheduled, a shard's `fetch` and `alarm`, the registry entrypoint) runs in an
 * isolate that evaluated that module first.
 */
export const allowLocalJurisdiction = (env: LocalJurisdictionEnv): void => {
    if (env.ENVIRONMENT !== "development") {
        return;
    }

    shim(env.SHARD);
    shim(env.SHARD_REGISTRY);
    shim(env.SCHEDULER);
};
