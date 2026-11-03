import { describe, expect, it } from "vitest";

import { allowLocalJurisdiction } from "./local-jurisdiction";

const NOT_IMPLEMENTED = /not implemented/u;

/** A stand-in for workerd's namespace class, fresh per test: its `jurisdiction()` throws. */
const makeNamespaceClass = () =>
    class {
        public jurisdiction(_jurisdiction: string): unknown {
            throw new Error("Jurisdiction restrictions are not implemented in workerd.");
        }
    };

describe("allowLocalJurisdiction", () => {
    it("makes jurisdiction() return the namespace itself in development, on the binding and on any other of the class", () => {
        const Namespace = makeNamespaceClass();
        const shard = new Namespace();
        const registry = new Namespace();
        const scheduler = new Namespace();
        const another = new Namespace();

        allowLocalJurisdiction({ ENVIRONMENT: "development", SCHEDULER: scheduler, SHARD: shard, SHARD_REGISTRY: registry });

        expect(shard.jurisdiction("eu")).toBe(shard);
        expect(registry.jurisdiction("eu")).toBe(registry);
        expect(scheduler.jurisdiction("eu")).toBe(scheduler);
        // A Durable Object's or an entrypoint's own `env` holds other instances of the class.
        expect(another.jurisdiction("eu")).toBe(another);
    });

    it("leaves a deployed namespace alone", () => {
        const shard = new (makeNamespaceClass())();

        allowLocalJurisdiction({ ENVIRONMENT: "production", SHARD: shard });
        allowLocalJurisdiction({ SHARD: shard });

        expect(() => shard.jurisdiction("eu")).toThrow(NOT_IMPLEMENTED);
    });

    it("ignores a binding that is absent or has no jurisdiction()", () => {
        expect(() => allowLocalJurisdiction({ ENVIRONMENT: "development", SHARD: {} })).not.toThrow();
        expect(() => allowLocalJurisdiction({ ENVIRONMENT: "development" })).not.toThrow();
    });
});
