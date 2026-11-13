import { describe, expect, it, vi } from "vitest";

import type { PushPermission, PushPlatform, PushServer } from "./push-registration";
import {
    createAccountChecks,
    createForegroundGate,
    createPendingWork,
    createPromptOffer,
    createSerialSteps,
    createTokenChangeFilter,
    languageTag,
    LAST_ACCOUNT_KEY,
    noteAccountOnPhone,
    onceItWorks,
    PENDING_REMOVAL,
    pushIdsIn,
    registerPhoneForPush,
    releaseOnSignOut,
    releasePhonePush,
    routeForPush,
} from "./push-registration";

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
        expect(server.register).toHaveBeenCalledWith("ios", TOKEN, undefined);
        expect(platform.requestPermission).not.toHaveBeenCalled();
    });

    it("sends the phone's language with the token, so the server words the alert in it", async () => {
        const server = serverWith();

        await registerPhoneForPush({ canPrompt: false, language: "de-AT", platform: platformWith({ canAskAgain: true, granted: true }), server });

        expect(server.register).toHaveBeenCalledWith("ios", TOKEN, "de-AT");
    });

    it("shows no prompt once sign-out has begun", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });
        const server = serverWith();

        expect(await registerPhoneForPush({ canPrompt: true, isCurrent: () => false, platform, server })).toBeUndefined();
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

    it("lets a failure to get the token reach sign-out, which logs it, and sends nothing", async () => {
        const platform = platformWith({ canAskAgain: true, granted: false });
        const server = serverWith();

        vi.mocked(platform.getDeviceToken).mockRejectedValueOnce(new Error("no token"));

        await expect(releasePhonePush({ platform, server })).rejects.toThrow("no token");
        expect(server.unregister).not.toHaveBeenCalled();
    });
});

describe("releaseOnSignOut", () => {
    it("closes the gate, waits for a registration already on its way, then releases the token", async () => {
        const order: string[] = [];
        const registrations = createPendingWork();
        const server = serverWith();
        const platform = platformWith({ canAskAgain: true, granted: true });

        vi.mocked(server.unregister).mockImplementation(async () => {
            order.push("release");
        });

        const registering = registrations.run(async (isCurrent) => {
            await Promise.resolve();
            order.push(isCurrent() ? "registered while open" : "registration refused");
        });

        await releaseOnSignOut({ platform, registrations, server });
        await registering;

        expect(order).toEqual(["registration refused", "release"]);
        expect(server.unregister).toHaveBeenCalledWith(TOKEN);
    });

    it("releases nothing, and warns of nothing, on a build that cannot receive push", async () => {
        const platform = { ...platformWith({ canAskAgain: true, granted: true }), canReceivePush: false };
        const server = serverWith();

        await releaseOnSignOut({ platform, registrations: createPendingWork(), server });

        expect(platform.getDeviceToken).not.toHaveBeenCalled();
        expect(server.unregister).not.toHaveBeenCalled();
    });
});

describe("createPendingWork", () => {
    it("lets sign-out wait for a registration already on its way, failed or not", async () => {
        vi.useFakeTimers();

        try {
            const work = createPendingWork();
            const order: string[] = [];
            const registering = work.run(async () => {
                // Still on its way when sign-out starts waiting.
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 20);
                });
                order.push("registered");
            });
            // Handled as it starts: a rejection left until after the timers run is reported as unhandled.
            const failing = expect(
                work.run(async () => {
                    throw new Error("offline");
                }),
            ).rejects.toThrow("offline");
            const settling = (async () => {
                await work.settle();
                order.push("settled");
            })();

            await vi.advanceTimersByTimeAsync(20);
            await Promise.all([registering, failing, settling]);

            expect(order).toEqual(["registered", "settled"]);
        } finally {
            vi.useRealTimers();
        }
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

    it("keeps work started while the gate was closed refused after the next sign-in reopens it", async () => {
        const work = createPendingWork();
        const seen: boolean[] = [];
        let isStillCurrent: () => boolean = () => true;

        work.close();
        await work.run(async (isCurrent) => {
            isStillCurrent = isCurrent;
        });
        work.open();
        seen.push(isStillCurrent());

        expect(seen).toEqual([false]);
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

describe("languageTag", () => {
    it("keeps language, script and region, and drops extensions the server would refuse", () => {
        expect(languageTag("de-AT")).toBe("de-AT");
        expect(languageTag("zh-Hans-CN")).toBe("zh-Hans-CN");
        expect(languageTag("en-US-u-ca-buddhist-nu-thai-hc-h12")).toBe("en-US");
        expect(languageTag("pt_BR")).toBe("pt-BR");
        expect(languageTag("es-419")).toBe("es-419");
        expect(languageTag("not a locale")).toBeUndefined();
    });
});

describe("createTokenChangeFilter", () => {
    it("ignores the event the app's own token fetch fires, and the same token again, so registering cannot loop", () => {
        const isRotation = createTokenChangeFilter();

        expect(isRotation("t1")).toBe(false);
        expect(isRotation("t1")).toBe(false);
        expect(isRotation("t2")).toBe(true);
        expect(isRotation("t2")).toBe(false);
    });
});

describe("createForegroundGate", () => {
    it("registers at most once a minute after one that went through, and tries again after one that did not", async () => {
        const clock = { now: 0 };
        const gate = createForegroundGate(60_000, () => clock.now);
        const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);

        await gate.run(attempt);
        clock.now = 1000;
        await gate.run(attempt);
        clock.now = 2000;
        await gate.run(attempt);

        // The first failed, so the second ran; the second went through, so the third waits a minute.
        expect(attempt).toHaveBeenCalledTimes(2);

        clock.now = 61_000;
        await gate.run(attempt);

        expect(attempt).toHaveBeenCalledTimes(3);
    });

    it("holds other returns off while one registration is on its way", async () => {
        const gate = createForegroundGate(60_000, () => 0);
        const release: { resolve?: (isRegistered: boolean) => void } = {};
        const attempt = vi.fn(
            async () =>
                await new Promise<boolean>((resolve) => {
                    release.resolve = resolve;
                }),
        );
        const first = gate.run(attempt);

        await gate.run(attempt);
        release.resolve?.(false);
        await first;

        expect(attempt).toHaveBeenCalledTimes(1);
    });
});

describe("createPromptOffer", () => {
    it("offers the prompt once per sign-in, only to the account signed in now", () => {
        const offer = createPromptOffer();

        expect(offer.claim("a")).toBe(false);

        offer.begin("a");

        expect(offer.claim("b")).toBe(false);
        expect(offer.claim("a")).toBe(true);
        expect(offer.claim("a")).toBe(false);
    });

    it("reopens a failed offer only for the account still signed in, and offers none once sign-out began", () => {
        const offer = createPromptOffer();

        offer.begin("a");
        offer.claim("a");
        offer.begin("b");
        offer.claim("b");
        // A's attempt fails after B signed in: it must not reopen B's offer.
        offer.release("a");

        expect(offer.claim("b")).toBe(false);

        offer.release("b");
        offer.end();

        expect(offer.claim("b")).toBe(false);
    });
});

describe("noteAccountOnPhone", () => {
    const device = (stored?: string) => {
        const items: Record<string, string> = stored === undefined ? {} : { [LAST_ACCOUNT_KEY]: stored };

        return {
            items,
            store: {
                digest: async (value: string) => `sha256:${value}`,
                read: async (key: string) => items[key] ?? null,
                write: vi.fn(async (key: string, value: string) => {
                    items[key] = value;
                }),
            },
        };
    };

    it("removes the previous account's alerts, then records the new account, even after a relaunch", async () => {
        const { items, store } = device("sha256:u1");
        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u2", store, removeAlerts);

        expect(removeAlerts).toHaveBeenCalledOnce();
        // Only a digest is kept: nothing naming the account stays on the phone.
        expect(items[LAST_ACCOUNT_KEY]).toBe("sha256:u2");
    });

    it("marks the record pending when its alerts could not be removed, so the next sign-in removes them, whoever it is", async () => {
        const { items, store } = device("sha256:u1");

        await expect(
            noteAccountOnPhone("u2", store, async () => {
                throw new Error("denied");
            }),
        ).rejects.toThrow("denied");
        expect(items[LAST_ACCOUNT_KEY]).toBe(PENDING_REMOVAL);

        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u1", store, removeAlerts);

        expect(removeAlerts).toHaveBeenCalledOnce();
    });

    it("removes nothing when the same person signs in again", async () => {
        const same = device("sha256:u1");
        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u1", same.store, removeAlerts);

        expect(removeAlerts).not.toHaveBeenCalled();
        expect(same.store.write).not.toHaveBeenCalled();
    });

    it("removes what was left on a phone with no record, then records the first account", async () => {
        const first = device();
        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u1", first.store, removeAlerts);

        expect(removeAlerts).toHaveBeenCalledOnce();
        expect(first.items[LAST_ACCOUNT_KEY]).toBe("sha256:u1");
    });
    it("removes nothing and writes nothing for a check that is no longer current", async () => {
        const { items, store } = device("sha256:u1");
        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u2", store, removeAlerts, () => false);

        expect(removeAlerts).not.toHaveBeenCalled();
        expect(store.write).not.toHaveBeenCalled();
        expect(items[LAST_ACCOUNT_KEY]).toBe("sha256:u1");
    });
    it("leaves a newer account's record alone when a removal that is no longer current fails", async () => {
        const { items, store } = device("sha256:u1");

        await expect(
            noteAccountOnPhone(
                "u2",
                store,
                async () => {
                    items[LAST_ACCOUNT_KEY] = "sha256:u3";
                    throw new Error("denied");
                },
                () => true,
            ),
        ).rejects.toThrow("denied");
        expect(items[LAST_ACCOUNT_KEY]).toBe("sha256:u3");
    });
});

describe("createSerialSteps", () => {
    it("runs each step only once the one asked for before it has finished", async () => {
        const run = createSerialSteps();
        const order: string[] = [];
        let release: () => void = () => undefined;
        let markStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = () => resolve();
        });

        const first = run(async () => {
            order.push("first:start");
            markStarted();
            await new Promise<void>((resolve) => {
                release = () => resolve();
            });
            order.push("first:end");
        });
        const second = run(async () => {
            order.push("second");
        });

        await started;
        expect(order).toEqual(["first:start"]);
        release();
        await Promise.all([first, second]);

        expect(order).toEqual(["first:start", "first:end", "second"]);
    });

    it("keeps the next step running when one fails, and reports the failure to its own caller", async () => {
        const run = createSerialSteps();
        const failed = run(async () => {
            throw new Error("denied");
        });
        const next = run(async () => "next");

        await expect(failed).rejects.toThrow("denied");
        await expect(next).resolves.toBe("next");
    });
});

describe("createAccountChecks", () => {
    it("runs the checks one after another, so a check starts only once the one before it has finished", async () => {
        const queue = createAccountChecks(1000, () => undefined);
        const order: string[] = [];
        let release: () => void = () => undefined;
        let markStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = () => resolve();
        });

        queue.run(async () => {
            order.push("first:start");
            markStarted();
            await new Promise<void>((resolve) => {
                release = () => resolve();
            });
            order.push("first:end");
        });
        queue.run(async () => {
            order.push("second");
        });

        await started;
        expect(order).toEqual(["first:start"]);
        release();
        await queue.settled();

        expect(order).toEqual(["first:start", "first:end", "second"]);
    });

    it("stops holding up the checks after a check that never finishes once the timeout has passed", async () => {
        vi.useFakeTimers();

        try {
            const warn = vi.fn();
            const queue = createAccountChecks(1000, warn);
            const next = vi.fn(async () => undefined);

            queue.run(async () => {
                await new Promise<void>(() => {});
            });
            queue.run(next);

            await vi.advanceTimersByTimeAsync(1000);
            await queue.settled();

            expect(next).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("tells a check that timed out that it is no longer live", async () => {
        vi.useFakeTimers();

        try {
            const queue = createAccountChecks(1000, () => undefined);
            let isLive: () => boolean = () => true;

            queue.run(async (live) => {
                isLive = live;
                await new Promise<void>(() => {});
            });

            await vi.advanceTimersByTimeAsync(1000);
            await queue.settled();

            expect(isLive()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("pushIdsIn", () => {
    it("reads the ids from the data, a JSON string, or Expo's body key", () => {
        expect(pushIdsIn({ notificationId: "n1", threadId: "t1" })).toStrictEqual({ notificationId: "n1", threadId: "t1" });
        expect(pushIdsIn({ data: JSON.stringify({ notificationId: "n2" }) })).toStrictEqual({ notificationId: "n2" });
        expect(pushIdsIn({ body: { notificationId: "n3" } })).toStrictEqual({ notificationId: "n3" });
    });

    it("ignores an id that is not a plain identifier, and a thread id that is not one either", () => {
        expect(pushIdsIn({ notificationId: "../etc", threadId: "t1" })).toBeUndefined();
        expect(pushIdsIn({ notificationId: "n1", threadId: "a b" })).toStrictEqual({ notificationId: "n1" });
    });
});

describe("routeForPush", () => {
    it("opens the chat a push names, and the chat list when it names none", () => {
        expect(routeForPush({ notificationId: "n1", threadId: "t1" })).toBe("/chat/t1");
        expect(routeForPush({ notificationId: "n1" })).toBe("/");
        expect(routeForPush(undefined)).toBe("/");
    });
});
