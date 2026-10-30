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

const crossings = vi.hoisted(() => {
    return { calls: [] as { args: unknown; reference: unknown; shardKey: string }[], run: undefined as undefined | ((args: unknown) => Promise<unknown>) };
});

// The route crosses to the owner's shard as the system (`systemRunners` -> `callOnShard`). The harness runs a
// registered function, not the generated path reference the route passes, so the crossing is recorded and the
// registered writer it names is run in its place.
vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: unknown, args: unknown, options: { shardKey: string }) => {
            crossings.calls.push({ args, reference, shardKey: options.shardKey });

            return await crossings.run?.(args);
        },
    };
});

/** The gateway's signing (`usage/tracker.ts#sendNotifications`), reproduced byte for byte. */
const signedRequest = async (payload: unknown, secret = SECRET, timestamp = Date.now()): Promise<Request> => {
    const body = JSON.stringify(payload);
    const bodyHash = await sha256Hex(new TextEncoder().encode(body));
    const signature = await hmacSha256Hex(secret, `POST\n/gateway/notifications\n${timestamp}\n${bodyHash}`);

    return new Request(ENDPOINT, { body, headers: { "X-Signature": signature, "X-Timestamp": String(timestamp) }, method: "POST" });
};

const firing = {
    action: "notify",
    currentValue: 5_250_000,
    firedAt: Date.UTC(2026, 0, 1, 10, 5),
    metric: "daily_cost",
    ruleId: "rule-1",
    ruleName: "Daily budget",
    threshold: 5_000_000,
};
const payload = { notifications: [firing], userId: "user-a" };

/** A firing as a gateway that predates `firedAt` sends it. */
const withoutFiredAt = () => Object.fromEntries(Object.entries(firing).filter(([key]) => key !== "firedAt"));

const crossed = () => crossings.calls;

/** The route's context: it crosses through `systemRunners`, so the context itself is never used to reach a shard. */
const forShard = vi.fn();
const context = () => ({ forShard }) as never;

const rows = async () =>
    (await harness.run(async (ctx: any) => await ctx.db.notifications.findMany({ where: { userId: "user-a" } }))) as {
        page: { body: string; link: string; title: string; type: string }[];
    };

beforeEach(() => {
    crossings.calls.length = 0;
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 10, 30), toFake: ["Date"] });
    vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", SECRET);
    harness = lunoraTest(schema as never);
    crossings.run = async (args) => await harness.run(async (ctx: any) => await ctx.runMutation(createNotifications, args));
});

afterEach(() => {
    harness.close();
    forShard.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe(gatewayNotificationsHttpAction, () => {
    it("rejects a request with no signature", async () => {
        const request = new Request(ENDPOINT, { body: JSON.stringify(payload), method: "POST" });

        const response = await gatewayNotificationsHttpAction(context(), request);

        expect(response.status).toBe(401);
        expect(crossed()).toStrictEqual([]);
    });

    it("rejects a request signed with the wrong secret", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload, "someone-else"));

        expect(response.status).toBe(401);
        expect(crossed()).toStrictEqual([]);
    });

    it("rejects everything while no secret is configured", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "");

        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload));

        expect(response.status).toBe(401);
        expect(crossed()).toStrictEqual([]);
    });

    it("refuses a body past the byte cap before hashing it, whatever its Content-Length says", async () => {
        const body = JSON.stringify({ notifications: [], padding: "x".repeat(300 * 1024), userId: "user-a" });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
            },
        });
        const request = new Request(ENDPOINT, {
            body: stream,
            duplex: "half",
            headers: { "X-Signature": "00", "X-Timestamp": String(Date.now()) },
            method: "POST",
        } as RequestInit);

        const response = await gatewayNotificationsHttpAction(context(), request);

        expect(response.status).toBe(401);
        expect(crossed()).toStrictEqual([]);
    });

    it("rejects a signed body that is not a notification batch", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: [{ ruleId: "r" }], userId: "user-a" }));

        expect(response.status).toBe(400);
        expect(crossed()).toStrictEqual([]);
    });

    it("crosses nowhere for a malformed user id, even when signed", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: [firing], userId: { a: 1 } }));

        expect(response.status).toBe(400);
        expect(crossed()).toStrictEqual([]);
    });

    it("creates one inbox notification for a valid request", async () => {
        const response = await gatewayNotificationsHttpAction(context(), await signedRequest(payload));

        expect(response.status).toBe(200);
        expect(crossed()).toStrictEqual([
            {
                args: { notifications: [expect.objectContaining({ type: "usage_alert", userId: "user-a" })] },
                reference: internal.notifications.functions.createNotifications,
                shardKey: "user-a",
            },
        ]);
        expect(forShard).not.toHaveBeenCalled();

        const { page } = await rows();

        expect(page).toHaveLength(1);
        expect(page[0]).toMatchObject({
            body: "Usage reached $5.25 (limit $5.00).",
            link: "/dashboard/settings/chat/usage",
            title: "Daily budget",
            type: "usage_alert",
        });
    });

    it("creates no second notification when the same firing is delivered again, even across an hour boundary", async () => {
        vi.setSystemTime(Date.UTC(2026, 0, 1, 10, 59, 59));
        await gatewayNotificationsHttpAction(context(), await signedRequest(payload));
        vi.setSystemTime(Date.UTC(2026, 0, 1, 11, 0, 1));
        const again = await gatewayNotificationsHttpAction(context(), await signedRequest(payload));

        expect(again.status).toBe(200);
        expect(crossed()).toHaveLength(2);
        const { page } = await rows();

        expect(page).toHaveLength(1);
    });

    it("accepts a firing with no firedAt and dedupes it within the hour of the signed timestamp", async () => {
        const legacy = withoutFiredAt();
        const legacyPayload = { notifications: [legacy], userId: "user-a" };

        const first = await gatewayNotificationsHttpAction(context(), await signedRequest(legacyPayload));
        const again = await gatewayNotificationsHttpAction(context(), await signedRequest(legacyPayload, SECRET, Date.now() + 1000));

        expect(first.status).toBe(200);
        expect(again.status).toBe(200);
        const sameHour = await rows();

        expect(sameHour.page).toHaveLength(1);

        vi.setSystemTime(Date.UTC(2026, 0, 1, 11, 30));
        await gatewayNotificationsHttpAction(context(), await signedRequest(legacyPayload));

        const nextHour = await rows();

        expect(nextHour.page).toHaveLength(2);
    });

    it("keeps a second firing of the same rule delivered in the same hour as the first", async () => {
        const later = { ...firing, firedAt: firing.firedAt + 3_599_000 };

        await gatewayNotificationsHttpAction(context(), await signedRequest(payload));
        await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: [later], userId: "user-a" }));

        const { page } = await rows();

        expect(page).toHaveLength(2);
    });

    it("writes a full batch of 50 firings in a single shard mutation", async () => {
        const many = Array.from({ length: 50 }, (_, index) => {
            return { ...firing, ruleId: `rule-${index}` };
        });

        const response = await gatewayNotificationsHttpAction(context(), await signedRequest({ notifications: many, userId: "user-a" }));

        expect(response.status).toBe(200);
        expect(crossed()).toHaveLength(1);

        const { page } = await rows();

        expect(page).toHaveLength(50);
    });

    it("skips a block-only rule", async () => {
        const response = await gatewayNotificationsHttpAction(
            context(),
            await signedRequest({ notifications: [{ ...firing, action: "block" }], userId: "user-a" }),
        );

        expect(response.status).toBe(200);
        expect(crossed()).toStrictEqual([]);
    });
});

describe(toUsageAlert, () => {
    it("keys a firing on its rule and the instant it fired", () => {
        const key = (notification: unknown) => toUsageAlert("u", notification as never, Date.now()).dedupeKey;

        expect(key(firing)).toBe(key({ ...firing }));
        expect(key(firing)).not.toBe(key({ ...firing, firedAt: firing.firedAt + 1 }));
        expect(key(firing)).not.toBe(key({ ...firing, ruleId: "rule-2" }));
    });

    it("keys a firing from a gateway that sends no firedAt on the hour of the signed timestamp", () => {
        const legacy = withoutFiredAt();
        const key = (requestedAt: number) => toUsageAlert("u", legacy as never, requestedAt).dedupeKey;
        const hour = Date.UTC(2026, 0, 1, 10);

        expect(key(hour + 1)).toBe(`usage_alert:rule-1:${hour / 3_600_000}`);
        expect(key(hour + 3_599_999)).toBe(key(hour + 1));
        expect(key(hour + 3_600_000)).not.toBe(key(hour + 1));
    });

    it("keeps the microdollars of a cost under half a cent instead of showing $0.00", () => {
        const alert = toUsageAlert("u", { ...firing, currentValue: 1500, threshold: 1 } as never, Date.now());

        expect(alert.body).toBe("Usage reached $0.0015 (limit $0.000001).");
    });

    it("words the blocked variant and non-cost metrics", () => {
        const alert = toUsageAlert(
            "u",
            { ...firing, action: "notify_and_block", currentValue: 120, metric: "request_count", threshold: 100 } as never,
            Date.now(),
        );

        expect(alert.body).toBe("Usage reached 120 requests (limit 100 requests). Requests are blocked for now.");
    });
});
