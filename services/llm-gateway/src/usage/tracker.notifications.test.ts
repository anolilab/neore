import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import type { NotificationEvent } from "./notifications.js";
import { sendNotifications } from "./tracker";

const env = { LUNORA_URL: "https://backend.test", SIGNING_SECRET: "s3cret" } as AppEnv;
const notifications: NotificationEvent[] = [{ action: "notify", currentValue: 5, metric: "daily_cost", ruleId: "r1", ruleName: "Budget", threshold: 4 }];

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
        const many = Array.from({ length: 120 }, (_, index): NotificationEvent => ({ ...notifications[0]!, ruleId: `r${index}` }));
        const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));

        vi.stubGlobal("fetch", fetchMock);

        await sendNotifications(env, "user-1", many);

        const sizes = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { notifications: unknown[] }).notifications.length);

        expect(sizes).toEqual([50, 50, 20]);
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

    it("still logs the status when releasing the reply body throws", async () => {
        const response = new Response("nope", { status: 503 });

        vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("cancel failed"));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => response),
        );

        await sendNotifications(env, "user-1", notifications);

        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("503");
    });
});
