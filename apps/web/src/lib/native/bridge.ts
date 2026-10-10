/**
 * The web side of the Tauri shell in `apps/native`. Every export is a NO-OP
 * outside it, so callers need no platform check of their own.
 *
 * Detection is `window.__TAURI__` (the shell sets `withGlobalTauri`), read
 * lazily so SSR and the plain browser never touch it. There is deliberately no
 * `@tauri-apps/api` dependency: the shell grants the remote origin four
 * commands (`notify`, `take_pending_compose`, `start_browser_sign_in_command`,
 * `take_pending_sign_in`), on desktop the five device-relay commands
 * (`device_*`, see "Device execution" below) plus event listening, and that
 * fits in a few lines against the global.
 *
 * The page's CSP does NOT allow Tauri's `ipc:` / `ipc.localhost` transport. That is intentional: Tauri falls back to `postMessage` IPC when
 * the fetch is blocked (one console warning per page load), so the web CSP
 * stays identical for every visitor. See `apps/native/README.md`.
 */

type UnlistenFunction = () => void;

/** Arguments of the shell's commands — strings only, all optional on the wire. */
type NativeCommandArgs = Partial<Record<string, string | undefined>>;

interface TauriGlobal {
    core: {
        invoke: <T = unknown>(command: string, args?: NativeCommandArgs) => Promise<T>;
    };
    event: {
        listen: (event: string, handler: (event: unknown) => void) => Promise<UnlistenFunction>;
    };
}

/** Event the shell emits when text is waiting for a new chat. Mirrors `COMPOSE_EVENT` in `apps/native/src-tauri/src/lib.rs`. */
export const NATIVE_COMPOSE_EVENT = "neore:compose";

/** A reply shorter than this finished while the user was probably still watching. */
export const LONG_REPLY_MS = 15_000;

const getTauri = (): TauriGlobal | undefined => {
    const candidate = (globalThis as { __TAURI__?: Partial<TauriGlobal> }).__TAURI__;

    return typeof candidate?.core?.invoke === "function" && typeof candidate.event?.listen === "function" ? (candidate as TauriGlobal) : undefined;
};

export const isNativeShell = (): boolean => getTauri() !== undefined;

export interface NativeNotification {
    body?: string;
    title: string;
}

/**
 * Shows a system notification from the native shell. The shell drops it while
 * its window is focused, so callers need not check visibility. Never throws: a
 * notification is best-effort and must not break the flow that triggered it.
 */
export const notifyNative = async ({ body, title }: NativeNotification): Promise<void> => {
    const tauri = getTauri();

    if (!tauri) {
        return;
    }

    try {
        await tauri.core.invoke("notify", { body, title });
    } catch {
        // Permission denied (not the app's origin), notifications disabled, …
    }
};

/**
 * Whether a finished reply is worth a notification: it ran long, or the page
 * was not visible when it finished.
 */
export const shouldNotifyReplyFinished = (durationMs: number, documentHidden: boolean): boolean => documentHidden || durationMs >= LONG_REPLY_MS;

/** Takes (and clears) the text the shell is holding for a new chat, if any. */
export const takePendingCompose = async (): Promise<string | undefined> => {
    const tauri = getTauri();

    if (!tauri) {
        return undefined;
    }

    try {
        const text = await tauri.core.invoke<string | null>("take_pending_compose");

        return typeof text === "string" && text.trim() !== "" ? text : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Pulls a value the shell is holding once on subscribe (a cold start where the
 * page was not listening yet) and again on every `event`. Returns the
 * unsubscribe function; a no-op outside the shell.
 */
const onNativePending = <T>(event: string, take: () => Promise<T | undefined>, handler: (value: T) => void): UnlistenFunction => {
    const tauri = getTauri();

    if (!tauri) {
        return () => {};
    }

    let disposed = false;
    let unlisten: UnlistenFunction | undefined;

    const drain = async () => {
        const value = await take();

        if (value !== undefined && !disposed) {
            handler(value);
        }
    };

    const subscribe = async () => {
        try {
            const stop = await tauri.event.listen(event, () => {
                void drain();
            });

            if (disposed) {
                stop();
            } else {
                unlisten = stop;
            }
        } catch {
            // Listening denied: anything already pending is still drained below.
        }
    };

    void subscribe();
    void drain();

    return () => {
        disposed = true;
        unlisten?.();
    };
};

/**
 * Calls `handler` with every text the shell hands over (Quick Composer, a
 * `neore://new?text=` link, a share), including one that arrived before the
 * page loaded. Returns the unsubscribe function.
 */
export const onNativeCompose = (handler: (text: string) => void): UnlistenFunction => onNativePending(NATIVE_COMPOSE_EVENT, takePendingCompose, handler);

/** Mirrors `SIGN_IN_EVENT` in `apps/native/src-tauri/src/lib.rs`. */
export const NATIVE_SIGN_IN_EVENT = "neore:sign-in";

/** A system-browser sign-in the shell received — see `apps/native/src-tauri/src/sign_in.rs`. */
export interface NativeSignIn {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

const isNativeSignIn = (value: unknown): value is NativeSignIn => {
    const candidate = value as Partial<NativeSignIn> | null;

    return typeof candidate?.code === "string" && typeof candidate.codeVerifier === "string" && typeof candidate.redirectUri === "string";
};

/** Takes (and clears) the completed browser sign-in the shell is holding, if any. */
export const takePendingSignIn = async (): Promise<NativeSignIn | undefined> => {
    const tauri = getTauri();

    if (!tauri) {
        return undefined;
    }

    try {
        const value = await tauri.core.invoke<unknown>("take_pending_sign_in");

        return isNativeSignIn(value) ? value : undefined;
    } catch {
        return undefined;
    }
};

export const onNativeSignIn = (handler: (signIn: NativeSignIn) => void): UnlistenFunction => onNativePending(NATIVE_SIGN_IN_EVENT, takePendingSignIn, handler);

/**
 * Asks the shell to run sign-in in the system browser. The shell also starts
 * it by itself when the page navigates to a provider that blocks webviews.
 */
export const startNativeBrowserSignIn = async (): Promise<void> => {
    try {
        await getTauri()?.core.invoke("start_browser_sign_in_command");
    } catch {
        // Not permitted here; nothing to do.
    }
};

/**
 * The app-origin endpoint that exchanges the code and sets the session cookie
 * (`backend/lunora/auth/client-grant-cookie.ts`, reached through the app's
 * `/api/auth/*` proxy, so the cookie lands on THIS origin).
 */
export const NATIVE_SIGN_IN_COOKIE_PATH = "/api/auth/client-grant/cookie";

/** Exchanges a browser sign-in for a session cookie on this origin. Resolves whether it worked. */
export const completeNativeSignIn = async (signIn: NativeSignIn, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
    try {
        const response = await fetchImpl(NATIVE_SIGN_IN_COOKIE_PATH, {
            body: JSON.stringify({ code: signIn.code, codeVerifier: signIn.codeVerifier, redirectUri: signIn.redirectUri }),
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        await response.body?.cancel();

        return response.ok;
    } catch {
        return false;
    }
};

// ─── Device execution (`apps/native/src-tauri/src/device/`) ─────────────────
//
// The page is only a RELAY: it passes the backend's signed call envelopes to
// the shell and the shell's signed results back. It cannot approve a call,
// change what the shell shares, or read the pairing secret — those live in the
// shell's local window. See docs/plans/device-execution.md.

/** Mirrors `CHANGED_EVENT` in `apps/native/src-tauri/src/device/mod.rs`: the tool set changed. */
export const NATIVE_DEVICE_CHANGED_EVENT = "neore:device-changed";

export type NativeDevicePlatform = "linux" | "macos" | "windows";

export interface NativeDeviceStatus {
    accountLabel?: string | null;
    /** The backend device this shell is paired as; absent when unpaired. */
    deviceId?: string | null;
    platform: NativeDevicePlatform;
}

/** A payload and its HMAC, exactly as the shell or the backend signed it. */
export interface NativeSigned {
    payload: string;
    signature: string;
}

const isSigned = (value: unknown): value is NativeSigned =>
    typeof (value as Partial<NativeSigned> | null)?.payload === "string" && typeof (value as Partial<NativeSigned>).signature === "string";

/** The shell's pairing state; `undefined` outside the desktop shell (mobile has no device tools). */
export const getNativeDeviceStatus = async (): Promise<NativeDeviceStatus | undefined> => {
    try {
        const status = await getTauri()?.core.invoke<NativeDeviceStatus>("device_status");

        return status && typeof status.platform === "string" ? status : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Hands a freshly registered device's secret to the shell. The shell stores it
 * only after the user confirms in its local window; `false` when they declined.
 */
export const pairNativeDevice = async (pairing: { accountLabel: string; deviceId: string; secret: string }): Promise<boolean> => {
    const tauri = getTauri();

    if (!tauri) {
        return false;
    }

    return (await tauri.core.invoke<boolean>("device_pair", pairing)) === true;
};

/** The shell's signed tool list; `undefined` when unpaired or outside the shell. */
export const getNativeDeviceManifest = async (): Promise<NativeSigned | undefined> => {
    try {
        const manifest = await getTauri()?.core.invoke<unknown>("device_manifest");

        return isSigned(manifest) ? manifest : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Relays one signed call to the shell, which verifies it, asks the user and
 * runs it. Resolves with the signed result; rejects when the shell refused the
 * envelope itself (not paired, expired, forged).
 */
export const executeOnNativeDevice = async (call: { envelope: string; signature: string }): Promise<NativeSigned> => {
    const tauri = getTauri();

    if (!tauri) {
        throw new Error("Not running in the desktop app");
    }

    const result = await tauri.core.invoke<unknown>("device_execute", call);

    if (!isSigned(result)) {
        throw new Error("The desktop app returned no result");
    }

    return result;
};

/** Opens the shell's local window: shared folders, local MCP servers, allow rules. */
export const openNativeDeviceSettings = async (): Promise<void> => {
    try {
        await getTauri()?.core.invoke("device_open_settings");
    } catch {
        // Not permitted here; nothing to do.
    }
};

/** Mirrors `PROGRESS_EVENT` in `apps/native/src-tauri/src/device/mod.rs`: where a call is on the device. */
export const NATIVE_DEVICE_PROGRESS_EVENT = "neore:device-progress";

/** A signed "prompting" / "running" report for one call, relayed as-is to `reportDeviceCallProgress`. */
export interface NativeDeviceProgress extends NativeSigned {
    callId: string;
}

const isProgress = (value: unknown): value is NativeDeviceProgress => isSigned(value) && typeof (value as Partial<NativeDeviceProgress>).callId === "string";

/**
 * Calls `handler` with each signed progress report the shell emits while it
 * works on a call (the approval window showed it; it started running). The page
 * cannot read or forge what it relays — the backend verifies the signature.
 */
export const onNativeDeviceProgress = (handler: (report: NativeDeviceProgress) => void): UnlistenFunction => {
    const tauri = getTauri();

    if (!tauri) {
        return () => {};
    }

    let disposed = false;
    let unlisten: UnlistenFunction | undefined;

    void (async () => {
        try {
            const stop = await tauri.event.listen(NATIVE_DEVICE_PROGRESS_EVENT, (event) => {
                const payload = (event as { payload?: unknown } | null)?.payload;

                if (!disposed && isProgress(payload)) {
                    handler({ callId: payload.callId, payload: payload.payload, signature: payload.signature });
                }
            });

            if (disposed) {
                stop();
            } else {
                unlisten = stop;
            }
        } catch {
            // Listening denied: the chat then shows the call as sent until it finishes.
        }
    })();

    return () => {
        disposed = true;
        unlisten?.();
    };
};

/** Calls `handler` once on subscribe and again whenever the shell's tool set changed (folders, servers, pairing). */
export const onNativeDeviceChanged = (handler: () => void): UnlistenFunction =>
    onNativePending(
        NATIVE_DEVICE_CHANGED_EVENT,
        async () => true,
        () => handler(),
    );
