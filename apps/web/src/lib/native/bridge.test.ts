import { afterEach, describe, expect, it, vi } from "vitest";

import {
    completeNativeSignIn,
    executeOnNativeDevice,
    getNativeDeviceStatus,
    isNativeShell,
    LONG_REPLY_MS,
    NATIVE_SIGN_IN_COOKIE_PATH,
    notifyNative,
    onNativeCompose,
    onNativeSignIn,
    shouldNotifyReplyFinished,
    startNativeBrowserSignIn,
    takePendingCompose,
    takePendingSignIn,
} from "./bridge";

type Native = {
    capabilities: string[];
    notify: ReturnType<typeof vi.fn>;
    onCompose: ReturnType<typeof vi.fn>;
    onSignIn?: ReturnType<typeof vi.fn>;
    startBrowserSignIn?: ReturnType<typeof vi.fn>;
    takePendingCompose: ReturnType<typeof vi.fn>;
    takePendingSignIn?: ReturnType<typeof vi.fn>;
};

const installNative = (overrides: Partial<Native> = {}): Native => {
    const native: Native = {
        capabilities: ["notifications", "compose"],
        notify: vi.fn(async () => undefined),
        onCompose: vi.fn(() => () => {}),
        takePendingCompose: vi.fn(async () => null),
        ...overrides,
    };

    (globalThis as { neoreNative?: Native }).neoreNative = native;

    return native;
};

afterEach(() => {
    delete (globalThis as { neoreNative?: Native }).neoreNative;
});

describe("outside the desktop shell", () => {
    it("is not detected", () => {
        expect(isNativeShell()).toBe(false);
    });

    it("ignores a partial bridge", () => {
        (globalThis as { neoreNative?: unknown }).neoreNative = { capabilities: ["notifications"] };

        expect(isNativeShell()).toBe(false);
    });

    it("makes every call a no-op", async () => {
        const handler = vi.fn();

        await notifyNative({ title: "Done" });
        expect(await takePendingCompose()).toBeUndefined();
        expect(await getNativeDeviceStatus()).toBeUndefined();
        expect(onNativeCompose(handler)).toBeTypeOf("function");
        expect(handler).not.toHaveBeenCalled();
    });
});

describe("inside the desktop shell", () => {
    it("is detected", () => {
        installNative();

        expect(isNativeShell()).toBe(true);
    });

    it("sends notifications through the bridge, with an optional body", async () => {
        const native = installNative();

        await notifyNative({ body: "Reply ready", title: "Neore" });
        await notifyNative({ title: "Only a title" });

        expect(native.notify).toHaveBeenNthCalledWith(1, "Neore", "Reply ready");
        expect(native.notify).toHaveBeenNthCalledWith(2, "Only a title", undefined);
    });

    it("swallows a rejected notify", async () => {
        installNative({ notify: vi.fn(async () => Promise.reject(new Error("denied"))) });

        await expect(notifyNative({ title: "x" })).resolves.toBeUndefined();
    });

    it("treats an empty pending compose as none", async () => {
        installNative({ takePendingCompose: vi.fn(async () => "   ") });

        expect(await takePendingCompose()).toBeUndefined();
    });

    it("drains text that arrived before the page listened, then text announced by the event", async () => {
        const handler = vi.fn();
        let announce: (() => void) | undefined;
        const native = installNative({
            onCompose: vi.fn((listener: () => void) => {
                announce = listener;

                return () => {};
            }),
            takePendingCompose: vi.fn().mockResolvedValueOnce("early").mockResolvedValueOnce("later").mockResolvedValue(null),
        });

        onNativeCompose(handler);
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("early"));

        announce?.();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("later"));
        expect(native.takePendingCompose).toHaveBeenCalledTimes(2);
    });

    it("stops delivering after dispose", async () => {
        const handler = vi.fn();
        const stop = vi.fn();
        installNative({
            onCompose: vi.fn(() => stop),
            takePendingCompose: vi.fn().mockResolvedValue("late"),
        });

        const dispose = onNativeCompose(handler);

        dispose();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(handler).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe(shouldNotifyReplyFinished, () => {
    it("notifies for long replies or when the page is hidden", () => {
        expect(shouldNotifyReplyFinished(LONG_REPLY_MS, false)).toBe(true);
        expect(shouldNotifyReplyFinished(LONG_REPLY_MS - 1, false)).toBe(false);
        expect(shouldNotifyReplyFinished(1000, true)).toBe(true);
    });
});

describe("browser sign-in", () => {
    it("posts code, verifier and redirect URI to the same-origin cookie endpoint", async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        const ok = await completeNativeSignIn({ code: "c", codeVerifier: "v", redirectUri: "neore://auth/callback" }, fetchImpl);

        expect(ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledWith(NATIVE_SIGN_IN_COOKIE_PATH, expect.objectContaining({ credentials: "same-origin", method: "POST" }));
    });

    it("reports a refused exchange or a network failure as false", async () => {
        expect(
            await completeNativeSignIn(
                { code: "c", codeVerifier: "v", redirectUri: "r" },
                vi.fn(async () => new Response(null, { status: 401 })),
            ),
        ).toBe(false);
        expect(
            await completeNativeSignIn(
                { code: "c", codeVerifier: "v", redirectUri: "r" },
                vi.fn(async () => Promise.reject(new Error("net"))),
            ),
        ).toBe(false);
    });
});

describe("browser sign-in handoff", () => {
    const signIn = { code: "c", codeVerifier: "v", redirectUri: "neore://auth/callback" };

    it("does nothing without the sign-in capability, even when the bridge exists", async () => {
        const native = installNative({ capabilities: ["notifications", "compose"] });
        const handler = vi.fn();

        onNativeSignIn(handler);
        await startNativeBrowserSignIn();

        expect(native.onSignIn).toBeUndefined();
        expect(await takePendingSignIn()).toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
    });

    it("delivers a sign-in that arrived before the page subscribed, and each later one", async () => {
        let listener: () => void = () => {};
        const native = installNative({
            capabilities: ["notifications", "compose", "sign-in"],
            onSignIn: vi.fn((next: () => void) => {
                listener = next;

                return () => {};
            }),
            takePendingSignIn: vi.fn(async () => signIn),
        } as Partial<Native>);
        const handler = vi.fn();

        onNativeSignIn(handler);
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(signIn));

        native.takePendingSignIn = vi.fn(async () => ({ ...signIn, code: "later" }));
        listener();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    });

    it("reads nothing when the shell holds no sign-in, and treats a failure as nothing", async () => {
        installNative({ capabilities: ["sign-in"], onSignIn: vi.fn(() => () => {}), takePendingSignIn: vi.fn(async () => null) } as Partial<Native>);

        expect(await takePendingSignIn()).toBeUndefined();

        installNative({
            capabilities: ["sign-in"],
            onSignIn: vi.fn(() => () => {}),
            takePendingSignIn: vi.fn(async () => {
                throw new Error("ipc");
            }),
        } as Partial<Native>);

        expect(await takePendingSignIn()).toBeUndefined();
    });

    it("asks the shell to open the browser when it advertises sign-in", async () => {
        const startBrowserSignIn = vi.fn(async () => undefined);

        installNative({ capabilities: ["sign-in"], startBrowserSignIn } as Partial<Native>);
        await startNativeBrowserSignIn();

        expect(startBrowserSignIn).toHaveBeenCalledTimes(1);
    });
});

describe("device execution (not in the Electron shell yet)", () => {
    it("reads no status even inside the shell", async () => {
        installNative();

        expect(await getNativeDeviceStatus()).toBeUndefined();
    });

    it("rejects a call with a clear message instead of failing inside the shell", async () => {
        installNative();

        await expect(executeOnNativeDevice({ envelope: "e", signature: "s" })).rejects.toThrow("no device execution yet");
    });
});
