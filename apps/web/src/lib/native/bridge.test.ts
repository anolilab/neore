import { afterEach, describe, expect, it, vi } from "vitest";

import {
    completeNativeSignIn,
    executeOnNativeDevice,
    getNativeDeviceManifest,
    getNativeDeviceStatus,
    isNativeShell,
    LONG_REPLY_MS,
    NATIVE_SIGN_IN_COOKIE_PATH,
    notifyNative,
    onNativeCompose,
    onNativeDeviceChanged,
    onNativeDeviceProgress,
    onNativeFiles,
    onNativeSignIn,
    openNativeDeviceSettings,
    openThreadWindow,
    pairNativeDevice,
    shouldNotifyReplyFinished,
    startNativeBrowserSignIn,
    supportsThreadWindows,
    takePendingCompose,
    takePendingFiles,
    takePendingSignIn,
} from "./bridge";

type NativeDeviceRelayMock = Record<"execute" | "manifest" | "onChanged" | "onProgress" | "openSettings" | "pair" | "status", ReturnType<typeof vi.fn>>;

type Native = {
    capabilities: string[];
    device?: NativeDeviceRelayMock;
    notify: ReturnType<typeof vi.fn>;
    onCompose: ReturnType<typeof vi.fn>;
    onFiles?: ReturnType<typeof vi.fn>;
    onSignIn?: ReturnType<typeof vi.fn>;
    openThreadWindow?: ReturnType<typeof vi.fn>;
    startBrowserSignIn?: ReturnType<typeof vi.fn>;
    takePendingCompose: ReturnType<typeof vi.fn>;
    takePendingFiles?: ReturnType<typeof vi.fn>;
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

    Object.assign(globalThis, { neoreNative: native });

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
        Object.assign(globalThis, { neoreNative: { capabilities: ["notifications"] } });

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
        installNative({
            notify: vi.fn(async () => {
                throw new Error("denied");
            }),
        });

        await expect(notifyNative({ title: "x" })).resolves.toBeUndefined();
    });

    it("treats an empty pending compose as none", async () => {
        installNative({ takePendingCompose: vi.fn(async () => " ".repeat(3)) });

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
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
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
                vi.fn(async () => {
                    throw new Error("net");
                }),
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

        native.takePendingSignIn = vi.fn(async () => {
            return { ...signIn, code: "later" };
        });
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

const relay = (overrides: Partial<NativeDeviceRelayMock> = {}): NativeDeviceRelayMock => {
    const signed = async () => {
        return { payload: "", signature: "" };
    };

    return {
        execute: vi.fn(signed),
        manifest: vi.fn(signed),
        onChanged: vi.fn(() => () => {}),
        onProgress: vi.fn(() => () => {}),
        openSettings: vi.fn(async () => undefined),
        pair: vi.fn(async () => false),
        status: vi.fn(async () => null),
        ...overrides,
    };
};

describe("device execution without the device capability", () => {
    it("is inert even when the relay exists", async () => {
        installNative({ device: relay() });

        expect(await getNativeDeviceStatus()).toBeUndefined();
        expect(await pairNativeDevice({ accountLabel: "a", deviceId: "d", secret: "s" })).toBe(false);
        expect(await getNativeDeviceManifest()).toBeUndefined();
        await expect(executeOnNativeDevice({ envelope: "e", signature: "s" })).rejects.toThrow("no device execution yet");
    });

    it("calls the changed handler once on subscribe and returns a no-op unsubscribe", () => {
        installNative();
        const handler = vi.fn();

        onNativeDeviceChanged(handler)();

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe("device execution with the device capability", () => {
    it("passes the status through, and treats a failing core as no status", async () => {
        const device = relay({
            status: vi.fn(async () => {
                return { deviceId: "d1", platform: "macos" as const };
            }),
        });

        installNative({ capabilities: ["device"], device });

        expect(await getNativeDeviceStatus()).toEqual({ deviceId: "d1", platform: "macos" });

        device.status.mockRejectedValueOnce(new Error("core unavailable"));
        expect(await getNativeDeviceStatus()).toBeUndefined();
    });

    it("relays the call and returns the signed result unchanged", async () => {
        const device = relay({
            execute: vi.fn(async () => {
                return { payload: "p", signature: "sig" };
            }),
        });

        installNative({ capabilities: ["device"], device });

        expect(await executeOnNativeDevice({ envelope: "e", signature: "s" })).toEqual({ payload: "p", signature: "sig" });
        expect(device.execute).toHaveBeenCalledWith({ envelope: "e", signature: "s" });
    });

    it("passes a rejection from the shell to the caller", async () => {
        installNative({
            capabilities: ["device"],
            device: relay({
                execute: vi.fn(async () => {
                    throw new Error("expired");
                }),
            }),
        });

        await expect(executeOnNativeDevice({ envelope: "e", signature: "s" })).rejects.toThrow("expired");
    });

    it("returns the shell's pairing answer, and false when it refuses", async () => {
        const device = relay({ pair: vi.fn(async () => true) });

        installNative({ capabilities: ["device"], device });

        expect(await pairNativeDevice({ accountLabel: "a", deviceId: "d", secret: "s" })).toBe(true);
        expect(device.pair).toHaveBeenCalledWith({ accountLabel: "a", deviceId: "d", secret: "s" });

        device.pair.mockRejectedValueOnce(new Error("bad secret"));
        expect(await pairNativeDevice({ accountLabel: "a", deviceId: "d", secret: "s" })).toBe(false);
    });

    it("forwards progress reports and change events, and unsubscribes", () => {
        const stopProgress = vi.fn();
        const stopChanged = vi.fn();
        const device = relay({
            onChanged: vi.fn(() => stopChanged),
            onProgress: vi.fn(() => stopProgress),
        });

        installNative({ capabilities: ["device"], device });
        const handler = vi.fn();

        onNativeDeviceProgress(handler);
        onNativeDeviceChanged(() => {})();

        expect(device.onProgress).toHaveBeenCalledWith(handler);
        expect(stopChanged).toHaveBeenCalledTimes(1);
        expect(stopProgress).not.toHaveBeenCalled();
    });

    it("opens the local window through the relay, and swallows a failure", async () => {
        const device = relay({
            openSettings: vi.fn(async () => {
                throw new Error("closed");
            }),
        });

        installNative({ capabilities: ["device"], device });

        await expect(openNativeDeviceSettings()).resolves.toBeUndefined();
        expect(device.openSettings).toHaveBeenCalledTimes(1);
    });
});

describe("thread windows", () => {
    it("is off and inert without the capability", async () => {
        const openThreadWindowMock = vi.fn(async () => undefined);

        installNative({ openThreadWindow: openThreadWindowMock });

        expect(supportsThreadWindows()).toBe(false);
        expect(await openThreadWindow("thread_1")).toBe(false);
        expect(openThreadWindowMock).not.toHaveBeenCalled();
    });

    it("opens the thread through the shell when advertised", async () => {
        const openThreadWindowMock = vi.fn(async () => undefined);

        installNative({ capabilities: ["thread-windows"], openThreadWindow: openThreadWindowMock });

        expect(supportsThreadWindows()).toBe(true);
        expect(await openThreadWindow("thread_1")).toBe(true);
        expect(openThreadWindowMock).toHaveBeenCalledWith("thread_1");
    });

    it("reports false when the shell refuses the id", async () => {
        installNative({
            capabilities: ["thread-windows"],
            openThreadWindow: vi.fn(async () => {
                throw new Error("invalid thread id");
            }),
        });

        expect(await openThreadWindow("../settings")).toBe(false);
    });
});

describe("dock files", () => {
    it("hands over the files the shell is holding as File objects", async () => {
        installNative({
            onFiles: vi.fn(() => () => {}),
            takePendingFiles: vi.fn(async () => [{ data: new Uint8Array([104, 105]), name: "note.txt" }]),
        });

        const handler = vi.fn();

        onNativeFiles(handler);

        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

        const [files] = handler.mock.lastCall as [File[]];

        expect(files.map((file) => [file.name, file.size])).toEqual([["note.txt", 2]]);
    });

    it("returns no files outside the shell or when the shell has none", async () => {
        expect(await takePendingFiles()).toEqual([]);

        installNative({ takePendingFiles: vi.fn(async () => []) });

        expect(await takePendingFiles()).toEqual([]);
    });
});
