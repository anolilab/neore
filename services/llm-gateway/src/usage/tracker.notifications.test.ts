import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import type { NotificationEvent } from "./notifications.js";
import { evaluateRules } from "./notifications.js";
import type { UsageLogEntry } from "./tracker";
import { sendNotifications, UsageTracker } from "./tracker";

const env = { LUNORA_URL: "https://backend.test", SIGNING_SECRET: "s3cret" } as AppEnv;
const notifications: NotificationEvent[] = [
    { action: "notify", currentValue: 5, firedAt: 1000, metric: "daily_cost", ruleId: "r1", ruleName: "Budget", threshold: 4 },
];

describe(sendNotifications, () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("posts the signed batch to /gateway/notifications and stays quiet on success", async () => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        await sendNotifications(env, "user-1", notifications);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]![0]).toBe("https://backend.test/gateway/notifications");
        expect(fetchMock.mock.calls[0]![1].headers).toHaveProperty("X-Signature");
        expect(console.error).not.toHaveBeenCalled();
    });

    it("logs the status and the actions, once, when the backend refuses, without payload contents or a retry", async () => {
        const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));

        vi.stubGlobal("fetch", fetchMock);

        await sendNotifications(env, "user-1", notifications);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(console.error).toHaveBeenCalledOnce();

        const logged = JSON.stringify(vi.mocked(console.error).mock.calls);

        expect(logged).toContain("401");
        expect(logged).toContain("notify");
        expect(logged).not.toContain("user-1");
        expect(logged).not.toContain("Budget");
        expect(logged).not.toContain("s3cret");
    });

    it("splits a large batch into signed requests of at most 50 and sends every rule", async () => {
        const many = Array.from({ length: 120 }, (_, index): NotificationEvent => {
            return { ...notifications[0]!, ruleId: `r${index}` };
        });
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        await sendNotifications(env, "user-1", many);

        const sizes = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { notifications: unknown[] }).notifications.length);

        expect(sizes).toEqual([50, 50, 20]);
    });

    it("sends slices with bounded concurrency rather than one after another", async () => {
        const many = Array.from({ length: 300 }, (_, index): NotificationEvent => {
            return { ...notifications[0]!, ruleId: `r${index}` };
        });
        let inFlight = 0;
        let peak = 0;
        const fetchMock = vi.fn(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });
            inFlight -= 1;

            return new Response("{}", { status: 200 });
        });

        vi.stubGlobal("fetch", fetchMock);

        await sendNotifications(env, "user-1", many);

        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(peak).toBe(4);
    });

    it("gives up on the remaining slices at the overall deadline and logs each one", async () => {
        const many = Array.from({ length: 300 }, (_, index): NotificationEvent => {
            return { ...notifications[0]!, ruleId: `r${index}` };
        });
        const deadline = new AbortController();
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);

        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => (ms === 25_000 ? deadline.signal : realTimeout(ms)));
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async (_url: string, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => {
                            reject(new DOMException("aborted", "AbortError"));
                        });
                    }),
            ),
        );

        const delivery = sendNotifications(env, "user-1", many);

        await vi.waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(4);
        });
        deadline.abort();
        await delivery;

        // Four slices were in flight and aborted; the other two never start.
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(console.error).toHaveBeenCalledTimes(6);
    });

    it("logs a transport failure, once per batch, without the user or payload", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("connection reset");
            }),
        );

        await sendNotifications(env, "user-1", notifications);

        expect(console.error).toHaveBeenCalledOnce();

        const logged = JSON.stringify(vi.mocked(console.error).mock.calls);

        expect(logged).toContain("connection reset");
        expect(logged).not.toContain("user-1");
        expect(logged).not.toContain("Budget");
    });

    it("does not report a delivered batch as failed when releasing the reply body throws", async () => {
        const response = new Response("{}", { status: 200 });

        vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("cancel failed"));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => response),
        );

        await sendNotifications(env, "user-1", notifications);

        expect(console.error).not.toHaveBeenCalled();
    });

    it("logs the status once when the backend refuses and releasing the reply body throws", async () => {
        const response = new Response("nope", { status: 503 });

        vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("cancel failed"));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => response),
        );

        await sendNotifications(env, "user-1", notifications);

        expect(console.error).toHaveBeenCalledOnce();
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("503");
    });
});

/** A D1 stand-in: one active rule that has fired, every other statement a no-op. */
const firingDatabase = (action = "notify") => {
    const rule = {
        action,
        id: "rule-1",
        last_triggered_at: null,
        metric: "request_count",
        model_filter: null,
        name: "Budget",
        period: "day",
        threshold: 1,
    };
    const statement = {
        all: async () => {
            return { results: [rule] };
        },
        bind: () => statement,
        first: async () => {
            return { total: 5 };
        },
        run: async () => {
            return {};
        },
    };

    return { prepare: () => statement } as unknown as D1Database;
};

describe(evaluateRules, () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("stamps each firing with the instant it fired, so a later delivery cannot change its identity", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 10, 59, 58), toFake: ["Date"] });

        const result = await evaluateRules({ USAGE_DB: firingDatabase() } as AppEnv, "user-1", undefined, {} as UsageLogEntry);

        expect(result.notifications).toEqual([expect.objectContaining({ firedAt: Date.UTC(2026, 0, 1, 10, 59, 58), ruleId: "rule-1" })]);
    });
});

describe("UsageTracker.recordAndEvaluate", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("starts the delivery deadline before it records, so recording spends the same window", async () => {
        const order: string[] = [];
        const tracker = new UsageTracker({ USAGE_DB: firingDatabase() } as AppEnv);
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);

        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
            if (ms === 25_000) order.push("deadline");

            return realTimeout(ms);
        });
        vi.spyOn(tracker, "record").mockImplementation(async () => {
            order.push("record");
        });

        await tracker.recordAndEvaluate({ userId: "user-1" } as UsageLogEntry);

        expect(order).toEqual(["deadline", "record"]);
    });
});

describe("UsageTracker.recordAndEvaluate blocking alerts", () => {
    const send = async (put: () => Promise<void>) => {
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        const tracker = new UsageTracker({ ...env, RATE_LIMIT_KV: { put }, USAGE_DB: firingDatabase("notify_and_block") } as unknown as AppEnv);

        vi.spyOn(tracker, "record").mockResolvedValue(undefined);

        const result = await tracker.recordAndEvaluate({ userId: "user-1" } as UsageLogEntry);
        const sent = fetchMock.mock.calls.flatMap(([, init]) => (JSON.parse(String(init.body)) as { notifications: NotificationEvent[] }).notifications);

        return { result, sent };
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("alerts with the blocking action once the marker is stored", async () => {
        const { sent } = await send(async () => undefined);

        expect(sent).toEqual([expect.objectContaining({ action: "notify_and_block", firedAt: expect.any(Number), ruleId: "rule-1" })]);
    });

    it("alerts as a plain notification when the marker cannot be stored, since nothing is then blocked", async () => {
        const { result, sent } = await send(async () => {
            throw new Error("kv down");
        });

        expect(sent).toEqual([expect.objectContaining({ action: "notify", firedAt: expect.any(Number), ruleId: "rule-1" })]);
        expect(result.blocked).toBe(true);
    });
});
