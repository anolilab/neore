import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExpoMessage } from "./expo-push";
import { isDeviceGone, sendExpoMessages } from "./expo-push";

const fetchMock = vi.fn<typeof fetch>();

const message = (index: number): ExpoMessage => {
    return { data: { notificationId: `n${String(index)}` }, priority: "high", to: `ExponentPushToken[t${String(index)}]`, ttl: 60 };
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("sendExpoMessages", () => {
    it("sends with the access token and reads one ticket per message", async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                data: [
                    { id: "r1", status: "ok" },
                    { details: { error: "DeviceNotRegistered" }, message: "gone", status: "error" },
                ],
            }),
        );

        const outcomes = await sendExpoMessages("secret", [message(1), message(2)]);
        const [url, init] = fetchMock.mock.calls[0]!;

        expect(url).toBe("https://exp.host/--/api/v2/push/send");
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
        expect(JSON.parse(init?.body as string)).toHaveLength(2);
        expect(outcomes).toStrictEqual([
            { id: "r1", status: "ok" },
            { error: "DeviceNotRegistered", message: "gone", status: "error" },
        ]);
    });

    it("sends at most 100 messages per request", async () => {
        fetchMock.mockImplementation(async (_url, init) => {
            const batch = JSON.parse(init?.body as string) as unknown[];

            return Response.json({
                data: batch.map(() => {
                    return { id: "r", status: "ok" };
                }),
            });
        });

        await sendExpoMessages(
            "secret",
            Array.from({ length: 150 }, (_, index) => message(index)),
        );

        expect(fetchMock.mock.calls.map(([, init]) => (JSON.parse(init?.body as string) as unknown[]).length)).toStrictEqual([100, 50]);
    });

    it("throws when Expo refuses the request as a whole, such as a bad access token", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 }));

        await expect(sendExpoMessages("wrong", [message(1)])).rejects.toThrow("Expo push API answered 401");
    });
});

describe("isDeviceGone", () => {
    it("is true for DeviceNotRegistered only", () => {
        expect(isDeviceGone({ error: "DeviceNotRegistered", message: "", status: "error" })).toBe(true);
        expect(isDeviceGone({ error: "InvalidCredentials", message: "", status: "error" })).toBe(false);
        expect(isDeviceGone({ error: "MessageRateExceeded", message: "", status: "error" })).toBe(false);
        expect(isDeviceGone({ id: "r", status: "ok" })).toBe(false);
        expect(isDeviceGone(undefined)).toBe(false);
    });
});
