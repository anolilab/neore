import { describe, expect, it, vi } from "vitest";

import type { PushPermission, PushPlatform, PushServer } from "./push-registration";
import { createPendingWork, createRegistrationRetry, isAccountSwitch, onceItWorks, pushIdsFromNotification, pushIdsIn, registerPhoneForPush, releasePhonePush, routeForPush } from "./push-registration";

const TOKEN = "a".repeat(64);

const platformWith = (permission: PushPermission, isAllowed = true): PushPlatform => {
    return {
        canReceivePush: true,
        getDeviceToken: vi.fn(async () => TOKEN),
        getPermission: vi.fn(async () => permission),
        platform: "ios",
        requestPermission: vi.fn(async () => isAllowed),
    };
};

const serverWith = (isOn = true): PushServer => {
    return { isEnabled: vi.fn(async () => isOn), register: vi.fn(async () => true), unregister: vi.fn(async () => undefined) };
};

describe("registerPhoneForPush", () => {
    it("registers the token on sign-in when push was allowed before, without asking", async () => {
        const platform = platformWith({ canAskAgain: false, granted: true });
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: false, platform, server })).toBe(TOKEN);
        expect(server.register).toHaveBeenCalledWith("ios", TOKEN);
        expect(platform.requestPermission).not.toHaveBeenCalled();
    });

    it("does not ask at sign-in; it waits for a moment worth being told about", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: false, platform, server })).toBeUndefined();
        expect(platform.requestPermission).not.toHaveBeenCalled();
        expect(server.register).not.toHaveBeenCalled();
    });

    it("asks when prompted, and registers once allowed", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: true, platform, server })).toBe(TOKEN);
        expect(platform.requestPermission).toHaveBeenCalledTimes(1);
    });

    it("registers nothing when the person declines, or declined for good before", async () => {
        const declined = platformWith({ canAskAgain: true, granted: false }, false);
        const blocked = platformWith({ canAskAgain: false, granted: false });
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: true, platform: declined, server })).toBeUndefined();
        expect(await registerPhoneForPush({ canPrompt: true, platform: blocked, server })).toBeUndefined();
        expect(blocked.requestPermission).not.toHaveBeenCalled();
        expect(server.register).not.toHaveBeenCalled();
    });

    it("drops a registration whose account signed out or switched before the token was sent", async () => {
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: false, isCurrent: () => false, platform: platformWith({ canAskAgain: false, granted: true }), server })).toBeUndefined();
        expect(server.register).not.toHaveBeenCalled();
    });

    it("never asks on a build that cannot get a push token, even with push on at the server", async () => {
        const platform = { ...platformWith({ canAskAgain: true, granted: false }), canReceivePush: false };
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: true, platform, server })).toBeUndefined();
        expect(platform.requestPermission).not.toHaveBeenCalled();
        expect(server.isEnabled).not.toHaveBeenCalled();
    });

    it("never asks for a permission the server cannot use (push is off without its keys)", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });

        expect(await registerPhoneForPush({ canPrompt: true, platform, server: serverWith(false) })).toBeUndefined();
        expect(platform.getPermission).not.toHaveBeenCalled();
        expect(platform.requestPermission).not.toHaveBeenCalled();
    });
});

describe("releasePhonePush", () => {
    it("unregisters this phone's token on sign-out", async () => {
        const server = serverWith();

        await releasePhonePush({ platform: platformWith({ canAskAgain: false, granted: true }), server });

        expect(server.unregister).toHaveBeenCalledWith(TOKEN);
    });

    it("unregisters even when notifications were turned off after registering", async () => {
        const server = serverWith();

        await releasePhonePush({ platform: platformWith({ canAskAgain: false, granted: false }), server });

        expect(server.unregister).toHaveBeenCalledWith(TOKEN);
    });

    it("sends nothing once its sign-out is over, so it cannot unregister the next account's phone", async () => {
        const work = createPendingWork();
        const isSigningOut = work.close();
        const server = serverWith();

        work.open();
        await releasePhonePush({ isCurrent: isSigningOut, platform: platformWith({ canAskAgain: false, granted: true }), server });

        expect(server.unregister).not.toHaveBeenCalled();
    });

    it("has nothing to release when the system gives no token", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });
        const server = serverWith();

        vi.mocked(platform.getDeviceToken).mockRejectedValueOnce(new Error("no token"));
        await releasePhonePush({ platform, server });

        expect(server.unregister).not.toHaveBeenCalled();
    });
});

describe("createPendingWork", () => {
    it("lets sign-out wait for a registration already on its way, failed or not", async () => {
        const work = createPendingWork();
        const order: string[] = [];
        const registering = work.run(async () => {
            // Still on its way when sign-out starts waiting.
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
            });
            order.push("registered");
        });
        const failing = work.run(async () => {
            throw new Error("offline");
        });
        const settling = (async () => {
            await work.settle();
            order.push("settled");
        })();

        await Promise.allSettled([registering, failing, settling]);

        expect(order).toEqual(["registered", "settled"]);
    });
});

describe("createPendingWork gate", () => {
    it("tells work started before sign-out closed the gate, and work started after, that its account has left", async () => {
        const work = createPendingWork();
        const seen: boolean[] = [];
        const check = async (isCurrent: () => boolean) => {
            seen.push(isCurrent());
        };

        await work.run(async (isCurrent) => {
            work.close();
            await check(isCurrent);
        });
        await work.run(check);
        work.open();
        await work.run(check);

        expect(seen).toEqual([false, false, true]);
    });
});

describe("onceItWorks", () => {
    it("tries a failed setup again, and stops once it worked", async () => {
        const step = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
        const setup = onceItWorks(step);

        await expect(setup()).rejects.toThrow("busy");
        await setup();
        await setup();

        expect(step).toHaveBeenCalledTimes(2);
    });
});

describe("createRegistrationRetry", () => {
    it("registers on the next foreground after a sign-in that had no network, then stops", async () => {
        const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
        const registration = createRegistrationRetry(attempt);

        await registration.run();
        await registration.retry();
        await registration.retry();

        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it("keeps retrying while notifications are off, so turning them on in the settings registers the phone", async () => {
        const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
        const registration = createRegistrationRetry(attempt);

        await registration.run();
        await registration.retry();
        await registration.retry();
        await registration.retry();

        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it("lets only the newest attempt decide, so an older success finishing late cannot hide a failed new token", async () => {
        const attempt = vi
            .fn<() => Promise<boolean>>()
            // The sign-in attempt is slow and ends up registered...
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 20);
                });

                return true;
            })
            // ...while the token rotated meanwhile and the newer attempt failed.
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const registration = createRegistrationRetry(attempt);

        const older = registration.run();

        await registration.run();
        await older;
        await registration.retry();

        expect(attempt).toHaveBeenCalledTimes(3);
    });
});

describe("isAccountSwitch", () => {
    it("is true only when one person replaces another, so their alerts are removed", () => {
        expect(isAccountSwitch("u1", "u2")).toBe(true);
        expect(isAccountSwitch("u1", "u1")).toBe(false);
        expect(isAccountSwitch(undefined, "u2")).toBe(false);
        expect(isAccountSwitch("u1", undefined)).toBe(false);
    });
});

describe("pushIdsIn", () => {
    it("reads the ids from the data, Expo's body key, an FCM message or a background task's dataString", () => {
        expect(pushIdsIn({ notificationId: "n1", threadId: "t1" })).toStrictEqual({ notificationId: "n1", threadId: "t1" });
        expect(pushIdsIn({ aps: {}, body: { notificationId: "n2" } })).toStrictEqual({ notificationId: "n2" });
        expect(pushIdsIn({ data: { notificationId: "n3" } })).toStrictEqual({ notificationId: "n3" });
        expect(pushIdsIn({ data: { dataString: JSON.stringify({ notificationId: "n4", threadId: "t4" }) } })).toStrictEqual({ notificationId: "n4", threadId: "t4" });
    });

    it("ignores anything that is not an id", () => {
        expect(pushIdsIn({ notificationId: "../../etc", threadId: "t" })).toBeUndefined();
        expect(pushIdsIn({ notificationId: "n1", threadId: "/chat/x?y" })).toStrictEqual({ notificationId: "n1" });
        expect(pushIdsIn({ dataString: "not json" })).toBeUndefined();
        expect(pushIdsIn(null)).toBeUndefined();
    });
});

describe("routeForPush", () => {
    it("opens the chat a push names, and the chat list otherwise", () => {
        expect(routeForPush({ notificationId: "n1", threadId: "t1" })).toBe("/chat/t1");
        expect(routeForPush({ notificationId: "n1" })).toBe("/");
        expect(routeForPush(undefined)).toBe("/");
    });

    it("routes a tapped notification by the ids in its content or the push it came from", () => {
        expect(routeForPush(pushIdsFromNotification({ content: { data: { notificationId: "n1", threadId: "t1" } } }))).toBe("/chat/t1");
        expect(routeForPush(pushIdsFromNotification({ content: { data: {} }, trigger: { payload: { body: { notificationId: "n2", threadId: "t2" } } } }))).toBe("/chat/t2");
        expect(routeForPush(pushIdsFromNotification({ content: {}, trigger: { remoteMessage: { data: { notificationId: "n3", threadId: "t3" } } } }))).toBe("/chat/t3");
    });
});
