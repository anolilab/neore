import { afterEach, describe, expect, it, vi } from "vitest";

import {
    completeNativeSignIn,
    executeOnNativeDevice,
    getNativeDeviceManifest,
    getNativeDeviceStatus,
    isNativeShell,
    LONG_REPLY_MS,
    NATIVE_COMPOSE_EVENT,
    NATIVE_DEVICE_CHANGED_EVENT,
    NATIVE_SIGN_IN_COOKIE_PATH,
    NATIVE_SIGN_IN_EVENT,
    notifyNative,
    onNativeCompose,
    onNativeDeviceChanged,
    onNativeSignIn,
    pairNativeDevice,
    shouldNotifyReplyFinished,
    startNativeBrowserSignIn,
    takePendingCompose,
    takePendingSignIn,
} from "./bridge";

const DESKTOP_APP_ERROR = /desktop app/u;
const NO_RESULT_ERROR = /no result/u;

const flush = async () => {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
};

const installTauri = (invokeImpl: (command: string) => Promise<unknown>) => {
    const listeners = new Map<string, (event: unknown) => void>();
    const unlisten = vi.fn();
    const invoke = vi.fn(invokeImpl);
    const listen = vi.fn(async (event: string, handler: (event: unknown) => void) => {
        listeners.set(event, handler);

        return unlisten;
    });

    vi.stubGlobal("__TAURI__", { core: { invoke }, event: { listen } });

    return { emit: (event: string) => listeners.get(event)?.({}), invoke, listen, unlisten };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("outside the native shell", () => {
    it("is not detected", () => {
        expect(isNativeShell()).toBe(false);
    });

    it("does not detect a partial or foreign __TAURI__ global", () => {
        vi.stubGlobal("__TAURI__", { core: {} });

        expect(isNativeShell()).toBe(false);

        vi.stubGlobal("__TAURI__", "tauri");

        expect(isNativeShell()).toBe(false);
    });

    it("makes every call a no-op", async () => {
        await expect(notifyNative({ title: "x" })).resolves.toBeUndefined();
        await expect(takePendingCompose()).resolves.toBeUndefined();
        await expect(takePendingSignIn()).resolves.toBeUndefined();
        await expect(startNativeBrowserSignIn()).resolves.toBeUndefined();

        const handler = vi.fn();
        const stop = onNativeCompose(handler);

        await flush();
        stop();

        expect(handler).not.toHaveBeenCalled();
    });
});

describe("inside the native shell", () => {
    it("is detected", () => {
        installTauri(async () => undefined);

        expect(isNativeShell()).toBe(true);
    });

    it("sends notifications through the notify command", async () => {
        const { invoke } = installTauri(async () => undefined);

        await notifyNative({ body: "done", title: "Reply ready" });

        expect(invoke).toHaveBeenCalledWith("notify", { body: "done", title: "Reply ready" });
    });

    it("swallows a rejected notify (e.g. IPC denied for this origin)", async () => {
        installTauri(async () => {
            throw new Error("not allowed");
        });

        await expect(notifyNative({ title: "x" })).resolves.toBeUndefined();
    });

    it("treats an empty pending compose as none", async () => {
        installTauri(async () => " ".repeat(3));

        await expect(takePendingCompose()).resolves.toBeUndefined();
    });

    it("drains text that arrived before the page listened, then text announced by the event", async () => {
        const queue: (string | null)[] = ["from a cold start", null, "from the quick composer"];
        const { emit, listen } = installTauri(async (command) => (command === "take_pending_compose" ? queue.shift() : undefined));
        const handler = vi.fn();

        const stop = onNativeCompose(handler);

        await flush();

        expect(listen).toHaveBeenCalledWith(NATIVE_COMPOSE_EVENT, expect.any(Function));
        expect(handler).toHaveBeenCalledWith("from a cold start");

        emit(NATIVE_COMPOSE_EVENT);
        await flush();

        emit(NATIVE_COMPOSE_EVENT);
        await flush();

        expect(handler.mock.calls).toEqual([["from a cold start"], ["from the quick composer"]]);

        stop();
    });

    it("unlistens on dispose, even when disposed before listen resolved", async () => {
        const { unlisten } = installTauri(async () => null);

        const stop = onNativeCompose(vi.fn());

        stop();
        await flush();

        expect(unlisten).toHaveBeenCalledOnce();
    });
});

describe(shouldNotifyReplyFinished, () => {
    it("notifies for long replies or when the page is hidden", () => {
        expect(shouldNotifyReplyFinished(LONG_REPLY_MS, false)).toBe(true);
        expect(shouldNotifyReplyFinished(LONG_REPLY_MS - 1, false)).toBe(false);
        expect(shouldNotifyReplyFinished(0, true)).toBe(true);
    });
});

describe("browser sign-in handoff", () => {
    const signIn = { code: "c".repeat(43), codeVerifier: "v".repeat(43), redirectUri: "neore://auth/callback" };

    it("delivers a sign-in the shell received before and after the page listened", async () => {
        const queue: unknown[] = [signIn, null, { ...signIn, code: "second" }];
        const { emit } = installTauri(async (command) => (command === "take_pending_sign_in" ? queue.shift() : undefined));
        const handler = vi.fn();

        const stop = onNativeSignIn(handler);

        await flush();
        emit(NATIVE_SIGN_IN_EVENT);
        await flush();
        emit(NATIVE_SIGN_IN_EVENT);
        await flush();

        expect(handler.mock.calls).toEqual([[signIn], [{ ...signIn, code: "second" }]]);

        stop();
    });

    it("ignores a malformed handoff", async () => {
        installTauri(async () => {
            return { code: "c" };
        });

        await expect(takePendingSignIn()).resolves.toBeUndefined();
    });

    it("asks the shell to start the browser flow", async () => {
        const { invoke } = installTauri(async () => undefined);

        await startNativeBrowserSignIn();

        expect(invoke).toHaveBeenCalledWith("start_browser_sign_in_command");
    });

    it("posts code, verifier and redirect URI to the same-origin cookie endpoint", async () => {
        const fetchImpl = vi.fn(async () => Response.json({ user: {} }));

        await expect(completeNativeSignIn(signIn, fetchImpl)).resolves.toBe(true);

        expect(fetchImpl).toHaveBeenCalledWith(NATIVE_SIGN_IN_COOKIE_PATH, expect.objectContaining({ credentials: "same-origin", method: "POST" }));
        expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual(signIn);
    });

    it("reports a refused exchange or a network failure as false", async () => {
        await expect(completeNativeSignIn(signIn, async () => new Response("{}", { status: 400 }))).resolves.toBe(false);
        await expect(
            completeNativeSignIn(signIn, async () => {
                throw new TypeError("offline");
            }),
        ).resolves.toBe(false);
    });
});

describe("device relay commands", () => {
    it("are inert outside the shell", async () => {
        await expect(getNativeDeviceStatus()).resolves.toBeUndefined();
        await expect(getNativeDeviceManifest()).resolves.toBeUndefined();
        await expect(pairNativeDevice({ accountLabel: "me", deviceId: "d", secret: "s" })).resolves.toBe(false);
        await expect(executeOnNativeDevice({ envelope: "{}", signature: "s" })).rejects.toThrow(DESKTOP_APP_ERROR);
    });

    it("read no status on a shell without device tools (mobile: the command is not granted)", async () => {
        installTauri(async () => {
            throw new Error("not allowed");
        });

        await expect(getNativeDeviceStatus()).resolves.toBeUndefined();
    });

    it("pass the envelope through untouched and return only a signed result", async () => {
        const { invoke } = installTauri(async (command) => (command === "device_execute" ? { payload: "p", signature: "s" } : undefined));

        await expect(executeOnNativeDevice({ envelope: "E", signature: "S" })).resolves.toEqual({ payload: "p", signature: "s" });
        expect(invoke).toHaveBeenCalledWith("device_execute", { envelope: "E", signature: "S" });
    });

    it("refuse a result that is not a signed payload", async () => {
        installTauri(async () => "nope");

        await expect(executeOnNativeDevice({ envelope: "E", signature: "S" })).rejects.toThrow(NO_RESULT_ERROR);
        await expect(getNativeDeviceManifest()).resolves.toBeUndefined();
    });

    it("report a tool-set change once on subscribe and on every event", async () => {
        const { emit } = installTauri(async () => undefined);
        const handler = vi.fn();
        const stop = onNativeDeviceChanged(handler);

        await flush();
        emit(NATIVE_DEVICE_CHANGED_EVENT);
        await flush();
        expect(handler).toHaveBeenCalledTimes(2);
        stop();
    });
});
