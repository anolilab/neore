import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { gatewayNotificationsHttpAction } from "./gateway-notifications";

const signed = { valid: true };

vi.mock("../../lib/sign-request", () => {
    return { verifySignedRequest: async () => signed.valid };
});

const calls: string[] = [];

vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: vi.fn(async (_reference: unknown, _args: unknown, options: { shardKey: string }) => {
            calls.push(options.shardKey);
        }),
    };
});

vi.mock("../../_generated/internal", () => {
    return { internal: { notifications: { functions: { createNotifications: { __lunoraRef: "n:create" } } } } };
});

const post = (body: unknown) => new Request("https://backend.test/gateway/notifications", { body: JSON.stringify(body), method: "POST" });
const context = { forShard: vi.fn() } as unknown as HttpActionCtx;
const firing = { action: "notify", currentValue: 5, metric: "cost", ruleId: "r1", ruleName: "Rule", threshold: 1 };

describe(gatewayNotificationsHttpAction, () => {
    it("writes the alerts on the verified user's shard as the system", async () => {
        calls.length = 0;
        process.env.LLM_GATEWAY_SIGNING_SECRET = "s";

        const response = await gatewayNotificationsHttpAction(context, post({ notifications: [firing], userId: "user-1" }));

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual(["user-1"]);
        expect(context.forShard).not.toHaveBeenCalled();
    });

    it("crosses nowhere for an unsigned request or a malformed user id", async () => {
        calls.length = 0;
        signed.valid = false;

        const unsigned = await gatewayNotificationsHttpAction(context, post({ notifications: [firing], userId: "victim" }));

        signed.valid = true;

        const malformed = await gatewayNotificationsHttpAction(context, post({ notifications: [firing], userId: { a: 1 } }));

        expect(unsigned.status).toBe(401);
        expect(malformed.status).toBe(400);
        expect(calls).toStrictEqual([]);
    });
});
