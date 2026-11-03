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

const shimmed = new WeakSet<object>();

const shim = (namespace: unknown): void => {
    if (typeof namespace !== "object" || namespace === null || shimmed.has(namespace)) {
        return;
    }

    shimmed.add(namespace);

    const target = namespace as JurisdictionNamespace;

    if (typeof target.jurisdiction !== "function") {
        return;
    }

    Object.defineProperty(namespace, "jurisdiction", { configurable: true, value: () => namespace });
};

/** Makes `jurisdiction()` on the Durable Object bindings return the binding itself, in development only. */
export const allowLocalJurisdiction = (env: LocalJurisdictionEnv): void => {
    if (env.ENVIRONMENT !== "development") {
        return;
    }

    shim(env.SHARD);
    shim(env.SHARD_REGISTRY);
    shim(env.SCHEDULER);
};
