import { describe, expect, it } from "vitest";

import { allowLocalJurisdiction } from "./local-jurisdiction";

const throwing = (): unknown => {
    throw new Error("Jurisdiction restrictions are not implemented in workerd.");
};

describe("allowLocalJurisdiction", () => {
    it("makes jurisdiction() return the namespace itself in development", () => {
        const shard = { jurisdiction: throwing };
        const registry = { jurisdiction: throwing };
        const scheduler = { jurisdiction: throwing };

        allowLocalJurisdiction({ ENVIRONMENT: "development", SCHEDULER: scheduler, SHARD: shard, SHARD_REGISTRY: registry });

        expect(shard.jurisdiction()).toBe(shard);
        expect(registry.jurisdiction()).toBe(registry);
        expect(scheduler.jurisdiction()).toBe(scheduler);
    });

    it("leaves a deployed namespace alone", () => {
        const shard = { jurisdiction: throwing };

        allowLocalJurisdiction({ ENVIRONMENT: "production", SHARD: shard });
        allowLocalJurisdiction({ SHARD: shard });

        expect(shard.jurisdiction).toBe(throwing);
    });

    it("ignores a binding that is absent or has no jurisdiction()", () => {
        expect(() => allowLocalJurisdiction({ ENVIRONMENT: "development", SHARD: {} })).not.toThrow();
    });
});
