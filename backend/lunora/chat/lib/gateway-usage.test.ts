import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { gatewayUsageReportHttpAction } from "./gateway-usage";

const signed = { valid: true };

vi.mock("../../lib/sign-request", () => {
    return { verifySignedRequest: async () => signed.valid };
});

const calls: { options: { shardKey: string }; reference: unknown }[] = [];

vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: vi.fn(async (reference: unknown, _args: unknown, options: { shardKey: string }) => {
            calls.push({ options, reference });
        }),
    };
});

vi.mock("../../_generated/internal", () => {
    return { internal: { auth: { billing: { deductCreditsFromGateway: { __lunoraRef: "auth_billing:deductCreditsFromGateway" } } } } };
});

const report = (body: unknown) => new Request("https://backend.test/gateway/usage-report", { body: JSON.stringify(body), method: "POST" });
const context = { forShard: vi.fn() } as unknown as HttpActionCtx;

describe(gatewayUsageReportHttpAction, () => {
    it("deducts on the verified user's shard as the system", async () => {
        calls.length = 0;

        const response = await gatewayUsageReportHttpAction(context, report({ costMicrodollars: 5, modelId: "m", requestId: "r", userId: "user-1" }));

        expect(response.status).toBe(200);
        expect(calls.map((call) => call.options.shardKey)).toStrictEqual(["user-1"]);
        expect(context.forShard).not.toHaveBeenCalled();
    });

    it("crosses nowhere for an unsigned request or a malformed user id", async () => {
        calls.length = 0;
        signed.valid = false;
        const unsigned = await gatewayUsageReportHttpAction(context, report({ costMicrodollars: 5, requestId: "r", userId: "victim" }));

        signed.valid = true;

        const malformed = await gatewayUsageReportHttpAction(context, report({ costMicrodollars: 5, requestId: "r", userId: { a: 1 } }));

        expect(unsigned.status).toBe(401);
        expect(malformed.status).toBe(400);
        expect(calls).toStrictEqual([]);
    });
});
