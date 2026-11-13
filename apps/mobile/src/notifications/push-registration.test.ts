import { describe, expect, it, vi } from "vitest";

import type { PushPermission, PushPlatform, PushServer } from "./push-registration";
import {
    createForegroundGate,
    createPendingWork,
    createPromptOffer,
    createTokenChangeFilter,
    dismissAccountAlerts,
    forgetAccountOnPhone,
    isAccountSwitch,
    languageTag,
    LAST_ACCOUNT_KEY,
    noteAccountOnPhone,
    onceItWorks,
    registerPhoneForPush,
    releaseOnSignOut,
    releasePhonePush,
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

describe("isAccountSwitch", () => {
    it("is true only when one person replaces another, so their alerts are removed", () => {
        expect(isAccountSwitch("u1", "u2")).toBe(true);
        expect(isAccountSwitch("u1", "u1")).toBe(false);
        expect(isAccountSwitch(undefined, "u2")).toBe(false);
        expect(isAccountSwitch("u1", undefined)).toBe(false);
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

    it("keeps the previous account on record when its alerts could not be removed, so the next sign-in still sees the switch", async () => {
        const { items, store } = device("sha256:u1");

        await expect(
            noteAccountOnPhone("u2", store, async () => {
                throw new Error("denied");
            }),
        ).rejects.toThrow("denied");
        expect(store.write).not.toHaveBeenCalled();
        expect(items[LAST_ACCOUNT_KEY]).toBe("sha256:u1");
    });

    it("removes nothing for the same person or the first sign-in on the phone, and writes only on a change", async () => {
        const same = device("sha256:u1");
        const first = device();
        const removeAlerts = vi.fn(async () => undefined);

        await noteAccountOnPhone("u1", same.store, removeAlerts);
        expect(same.store.write).not.toHaveBeenCalled();
        await noteAccountOnPhone("u1", first.store, removeAlerts);
        expect(first.items[LAST_ACCOUNT_KEY]).toBe("sha256:u1");
        expect(removeAlerts).not.toHaveBeenCalled();
    });

    it("keeps nothing of an account that signed out, so the next sign-in is a first one", async () => {
        const { items, store } = device("sha256:u1");
        const removeAlerts = vi.fn(async () => undefined);

        await forgetAccountOnPhone({
            remove: async (key) => {
                Reflect.deleteProperty(items, key);
            },
        });
        await noteAccountOnPhone("u2", store, removeAlerts);

        expect(removeAlerts).not.toHaveBeenCalled();
    });
});

describe("dismissAccountAlerts", () => {
    it("keeps the record of the account when its alerts could not be removed, so the next sign-in still sees the switch", async () => {
        const items: Record<string, string> = { [LAST_ACCOUNT_KEY]: "sha256:u1" };

        await expect(
            dismissAccountAlerts({
                dismissAll: async () => {
                    throw new Error("denied");
                },
                remove: async (key) => {
                    Reflect.deleteProperty(items, key);
                },
            }),
        ).rejects.toThrow("denied");
        expect(items[LAST_ACCOUNT_KEY]).toBe("sha256:u1");
    });

    it("removes the alerts, then forgets the account", async () => {
        const items: Record<string, string> = { [LAST_ACCOUNT_KEY]: "sha256:u1" };
        const calls: string[] = [];

        await dismissAccountAlerts({
            dismissAll: async () => {
                calls.push("dismiss");
            },
            remove: async (key) => {
                calls.push("forget");
                Reflect.deleteProperty(items, key);
            },
        });

        expect(calls).toEqual(["dismiss", "forget"]);
        expect(items[LAST_ACCOUNT_KEY]).toBeUndefined();
    });
});
