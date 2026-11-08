import { describe, expect, it, vi } from "vitest";

import type { PushPermission, PushPlatform, PushServer } from "./push-registration";
import { createForegroundGate, createPromptOffer, createTokenChangeFilter, languageTag, onceItWorks, registerPhoneForPush } from "./push-registration";

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
