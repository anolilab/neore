import { describe, expect, it, vi } from "vitest";

import { isShardRoutingEnabled, routedShardNamespace } from "./shard-namespace";

const fakeNamespace = () => {
    return {
        getByName: vi.fn((name: string) => `stub:${name}`),
        idFromName: vi.fn((name: string) => `id:${name}`),
    };
};

describe("isShardRoutingEnabled", () => {
    it("is on unless SHARD_ROUTING is exactly off", () => {
        expect(isShardRoutingEnabled({})).toBe(true);
        expect(isShardRoutingEnabled({ SHARD_ROUTING: "on" })).toBe(true);
        expect(isShardRoutingEnabled({ ENVIRONMENT: "development", SHARD_ROUTING: "off" })).toBe(false);
    });

    it.each(["production", "preview", undefined])("refuses the switch outside development (ENVIRONMENT=%s)", (environment) => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(isShardRoutingEnabled({ ENVIRONMENT: environment, SHARD_ROUTING: "off" })).toBe(true);
        expect(error).toHaveBeenCalledOnce();

        error.mockRestore();
    });
});

describe("routedShardNamespace", () => {
    it("passes the namespace through while routing is on", () => {
        const namespace = fakeNamespace();

        expect(routedShardNamespace(namespace, {})).toBe(namespace);
    });

    it("pins every shard key to __root__ when routing is off", () => {
        const namespace = fakeNamespace();
        const routed = routedShardNamespace(namespace, { ENVIRONMENT: "development", SHARD_ROUTING: "off" });

        expect(routed.idFromName("user-1")).toBe("id:__root__");
        expect(routed.getByName("user-2")).toBe("stub:__root__");
    });

    it("keeps routing in production even when switched off", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const namespace = fakeNamespace();

        expect(routedShardNamespace(namespace, { ENVIRONMENT: "production", SHARD_ROUTING: "off" }).idFromName("user-1")).toBe("id:user-1");

        error.mockRestore();
    });
});
