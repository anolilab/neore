import { describe, expect, it } from "vitest";

import { readRequestContext } from "./request-context";

describe(readRequestContext, () => {
    it("reads the nonce and PostHog data from `serverContext`, where Start puts them", async () => {
        const result = await readRequestContext({
            context: {},
            serverContext: {
                posthog: { distinctId: "d-1", flags: { beta: true } },
                security: { nonce: "abc123" },
            },
        });

        expect(result).toStrictEqual({ nonce: "abc123", posthog: { distinctId: "d-1", flags: { beta: true } } });
    });

    it("awaits flags handed on as a promise by the PostHog middleware", async () => {
        const result = await readRequestContext({
            serverContext: { posthog: { distinctId: "d-1", flags: Promise.resolve({ beta: "on" }) } },
        });

        expect(result.posthog).toStrictEqual({ distinctId: "d-1", flags: { beta: "on" } });
    });

    it("ignores the same keys on the router context, which Start never populates", async () => {
        const result = await readRequestContext({
            context: { posthog: { distinctId: "wrong", flags: {} }, security: { nonce: "wrong" } },
        });

        expect(result).toStrictEqual({ nonce: undefined, posthog: { distinctId: null, flags: {} } });
    });

    it("falls back to defaults on the client, where there is no `serverContext`", async () => {
        await expect(readRequestContext(undefined)).resolves.toStrictEqual({ nonce: undefined, posthog: { distinctId: null, flags: {} } });
    });
});
