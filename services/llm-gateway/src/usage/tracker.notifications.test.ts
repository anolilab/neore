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
});
