/**
 * POST /gateway/notifications against the in-memory harness: the signature gate,
 * and a signed batch landing in the user's inbox exactly once.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { hmacSha256Hex, sha256Hex } from "../../lib/crypto";
import { createNotifications } from "../../notifications/functions";
import schema from "../../schema";
import { gatewayNotificationsHttpAction, toUsageAlert } from "./gateway-notifications";

const SECRET = "gateway-secret";
const ENDPOINT = "https://backend.test/gateway/notifications";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

/** The gateway's signing (`usage/tracker.ts#sendNotifications`), reproduced byte for byte. */
const signedRequest = async (payload: unknown, secret = SECRET, timestamp = Date.now()): Promise<Request> => {
    const body = JSON.stringify(payload);
    const bodyHash = await sha256Hex(new TextEncoder().encode(body));
    const signature = await hmacSha256Hex(secret, `POST\n/gateway/notifications\n${timestamp}\n${bodyHash}`);

    return new Request(ENDPOINT, { body, headers: { "X-Signature": signature, "X-Timestamp": String(timestamp) }, method: "POST" });
};

const firing = { action: "notify", currentValue: 5_250_000, metric: "daily_cost", ruleId: "rule-1", ruleName: "Daily budget", threshold: 5_000_000 };
const payload = { notifications: [firing], userId: "user-a" };

const runMutation = vi.fn();

/**
 * A fake HTTP-action ctx whose shard-scoped mutation runs on the harness. The harness runs a
 * registered function, not the generated path reference the handler passes, so the reference is
 * recorded and the registered writer it names is run in its place.
 */
const context = () =>
    ({
        forShard: () => {
            return {
                runMutation: async (reference: unknown, args: unknown) => {
                    runMutation(reference, args);

                    return await harness.run(async (ctx: any) => await ctx.runMutation(createNotifications, args));
                },
            };
        },
    }) as never;

const rows = async () =>
    (await harness.run(async (ctx: any) => await ctx.db.notifications.findMany({ where: { userId: "user-a" } }))) as {
        page: { body: string; link: string; title: string; type: string }[];
    };

beforeEach(() => {
    // Mid-hour, so a re-sent request one second later cannot straddle the dedupe key's hour boundary.
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 10, 30), toFake: ["Date"] });
    vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", SECRET);
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    runMutation.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe(gatewayNotificationsHttpAction, () => {
    it("rejects a request with no signature", async () => {
        const request = new Request(ENDPOINT, { body: JSON.stringify(payload), method: "POST" });

        const response = await gatewayNotificationsHttpAction(context(), request);

        expect(response.status).toBe(401);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("rejects a request signed with the wrong secret", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload, "someone-else"));

        expect(response.status).toBe(401);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("rejects everything while no secret is configured", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "");

        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload));

        expect(response.status).toBe(401);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("rejects a signed body that is not a notification batch", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: [{ ruleId: "r" }], userId: "user-a" }));

        expect(response.status).toBe(400);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("creates one inbox notification for a valid request", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload));

        expect(response.status).toBe(200);
        expect(runMutation).toHaveBeenCalledExactlyOnceWith(internal.notifications.functions.createNotifications, {
            notifications: [expect.objectContaining({ type: "usage_alert", userId: "user-a" })],
        });

        const { page } = await rows();

        expect(page).toHaveLength(1);
        expect(page[0]).toMatchObject({
            body: "Usage reached $5.25 (limit $5.00).",
            link: "/dashboard/settings/chat/usage",
            title: "Daily budget",
            type: "usage_alert",
        });
    });

    it("creates no second notification when the same request is delivered again", async () => {
        const timestamp = Date.now();

        await gatewayNotificationsHttpAction(context(), await signedRequest(payload, SECRET, timestamp));
        const again = await gatewayNotificationsHttpAction(context(), await signedRequest(payload, SECRET, timestamp + 1000));

        expect(again.status).toBe(200);
        expect(runMutation).toHaveBeenCalledTimes(2);
        const { page } = await rows();

        expect(page).toHaveLength(1);
    });

    it("writes a full batch of 50 firings in a single shard mutation", async () => {
        const many = Array.from({ length: 50 }, (_, index) => {
            return { ...firing, ruleId: `rule-${index}` };
        });

        const response = await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: many, userId: "user-a" }));

        expect(response.status).toBe(200);
        expect(runMutation).toHaveBeenCalledTimes(1);

        const { page } = await rows();

        expect(page).toHaveLength(50);
    });

    it("skips a block-only rule", async () => {
        const response = await gatewayNotificationsHttpAction(
            context(),
            await signedRequest({ notifications: [{ ...firing, action: "block" }], userId: "user-a" }),
        );

        expect(response.status).toBe(200);
        expect(runMutation).not.toHaveBeenCalled();
    });
});

describe(toUsageAlert, () => {
    it("keys one firing per rule and hour, so the rule's next firing is a new row", () => {
        const at = Date.UTC(2026, 0, 1, 10, 5);
        const key = (ms: number) => toUsageAlert("u", firing as never, ms).dedupeKey;

        expect(key(at)).toBe(key(at + 30_000));
        expect(key(at)).not.toBe(key(at + 3_600_000));
    });

    it("words the blocked variant and non-cost metrics", () => {
        const alert = toUsageAlert("u", { ...firing, action: "notify_and_block", currentValue: 120, metric: "request_count", threshold: 100 } as never, 0);

        expect(alert.body).toBe("Usage reached 120 requests (limit 100 requests). Requests are blocked for now.");
    });
});
