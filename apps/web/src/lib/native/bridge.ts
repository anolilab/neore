/**
 * The web side of the desktop shell in `apps/desktop` (Electron). Every export
 * is a NO-OP outside it, so callers need no platform check of their own.
 *
 * The shell's preload exposes `window.neoreNative` on the site origin only, and
 * it lists in `capabilities` what this build can do. Anything not listed here
 * (sign-in in the system browser, device execution) is inert: device calls
 * reach the shell only when it advertises `device`, and `device` is the relay
 * in `apps/desktop/src/preload.ts`.
 */

type UnlistenFunction = () => void;

/** A file the shell read from disk for the page; `File` is built from it here. */
export interface NativeDroppedFile {
    data: Uint8Array<ArrayBuffer>;
    name: string;
}

/** What the Electron preload exposes (`apps/desktop/src/preload.ts`). */
interface NativeBridge {
    capabilities: ReadonlyArray<string>;
    device?: NativeDeviceRelay;
    notify: (title: string, body?: string) => Promise<void>;
    onCompose: (handler: () => void) => UnlistenFunction;
    /** A `neore://new?text=` link's text, for the composer to show and not send. Optional: older shells lack it. */
    onDraft?: (handler: () => void) => UnlistenFunction;
    /** Files dropped on the dock icon (macOS). Optional: older shells lack it. */
    onFiles?: (handler: () => void) => UnlistenFunction;
    onSignIn: (handler: () => void) => UnlistenFunction;
    openThreadWindow: (threadId: string) => Promise<void>;
    /** The dock / launcher badge count. Optional: older shells lack it. */
    setBadge?: (count: number) => Promise<void>;
    startBrowserSignIn: () => Promise<void>;
    takePendingCompose: () => Promise<string | undefined>;
    takePendingDraft?: () => Promise<string | undefined>;
    takePendingFiles?: () => Promise<NativeDroppedFile[]>;
    takePendingSignIn: () => Promise<NativeSignIn | undefined>;
}

/** The device relay the shell exposes when it advertises `device` (`apps/desktop/src/preload.ts`). Relay only. */
interface NativeDeviceRelay {
    execute: (call: { envelope: string; signature: string }) => Promise<NativeSigned>;
    hostConnect: (deviceId: string) => Promise<NativeHostProbe>;
    hostDisconnect: (deviceId: string) => Promise<void>;
    hostPair: (pairing: { deviceId: string; secret: string; spec: NativeHostSpec }) => Promise<boolean>;
    hostProbe: (spec: NativeHostSpec) => Promise<NativeHostProbe>;
    manifest: (deviceId?: string) => Promise<NativeSigned>;
    onChanged: (handler: () => void) => UnlistenFunction;
    onProgress: (handler: (report: NativeDeviceProgress) => void) => UnlistenFunction;
    openSettings: () => Promise<void>;
    pair: (pairing: { accountLabel: string; deviceId: string; secret: string }) => Promise<boolean>;
    status: () => Promise<NativeDeviceStatus | null>;
}

/** A reply shorter than this finished while the user was probably still watching. */
export const LONG_REPLY_MS = 15_000;

const getNative = (): NativeBridge | undefined => {
    const candidate = (globalThis as { neoreNative?: Partial<NativeBridge> }).neoreNative;

    return typeof candidate?.notify === "function" && typeof candidate.takePendingCompose === "function" && typeof candidate.onCompose === "function"
        ? (candidate as NativeBridge)
        : undefined;
};

export const isNativeShell = (): boolean => getNative() !== undefined;

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
    try {
        await getNative()?.notify(title, body);
    } catch {
        // Permission denied (not the app's origin), notifications disabled, …
    }
};

/**
 * Whether a finished reply is worth a notification: it ran long, or the page
 * was not visible when it finished.
 */
export const shouldNotifyReplyFinished = (durationMs: number, documentHidden: boolean): boolean => documentHidden || durationMs >= LONG_REPLY_MS;

/**
 * Sets the dock / launcher badge to the unread count (the shell clamps it to 0..999 and skips Windows).
 * Never throws: the badge is cosmetic, so a refused call must not break the page.
 */
export const setNativeBadge = async (count: number): Promise<void> => {
    try {
        await getNative()?.setBadge?.(count);
    } catch {
        // Not the app's origin, or the shell is too old to have the badge.
    }
};

/** Whether the shell can open a thread in its own window. Known synchronously, so a menu can show or hide the item. */
export const supportsThreadWindows = (): boolean => getNative()?.capabilities.includes("thread-windows") === true;

/** Opens the thread in its own shell window. `false` unless the shell advertises `thread-windows`, or when it refuses the id. */
export const openThreadWindow = async (threadId: string): Promise<boolean> => {
    if (!supportsThreadWindows()) {
        return false;
    }

    try {
        await getNative()?.openThreadWindow(threadId);

        return true;
    } catch {
        return false;
    }
};

/** Takes (and clears) the text of a deep link the shell is holding for the composer, if any. */
export const takePendingDraft = async (): Promise<string | undefined> => {
    try {
        const text = await getNative()?.takePendingDraft?.();

        return typeof text === "string" && text.trim() !== "" ? text : undefined;
    } catch {
        return undefined;
    }
};

/** Takes (and clears) the text the shell is holding for a new chat, if any. */
export const takePendingCompose = async (): Promise<string | undefined> => {
    try {
        const text = await getNative()?.takePendingCompose();

        return typeof text === "string" && text.trim() !== "" ? text : undefined;
    } catch {
        return undefined;
    }
};

/** Takes (and clears) the files the shell was handed on the dock icon, as `File`s. */
export const takePendingFiles = async (): Promise<File[]> => {
    try {
        const files = await getNative()?.takePendingFiles?.();

        return (files ?? []).map(({ data, name }) => new File([data], name));
    } catch {
        return [];
    }
};

/**
 * Pulls what the shell holds once on subscribe (a value that arrived before the
 * page listened) and again on every `listen` notification. `listen` returns
 * `undefined` when the shell does not offer that event, and then nothing is pulled.
 */
const onNativePending = <T>(
    listen: (listener: () => void) => UnlistenFunction | undefined,
    take: () => Promise<T | undefined>,
    handler: (value: T) => void,
): UnlistenFunction => {
    let disposed = false;

    const drain = async () => {
        const value = await take();

        if (value !== undefined && !disposed) {
            handler(value);
        }
    };

    const stop = listen(() => drain());

    if (stop === undefined) {
        return () => {};
    }

    void drain();

    return () => {
        disposed = true;
        stop();
    };
};

/**
 * Calls `handler` with each batch of files the shell is handed (the dock icon),
 * including a batch that arrived before the page loaded. Returns the unsubscribe function.
 */
export const onNativeFiles = (handler: (files: File[]) => void): UnlistenFunction =>
    onNativePending(
        (listener) => getNative()?.onFiles?.(listener),
        async () => {
            const files = await takePendingFiles();

            return files.length > 0 ? files : undefined;
        },
        handler,
    );

/**
 * Calls `handler` with every text the shell hands over (Quick Composer, a
 * `neore://new?text=` link, a share), including one that arrived before the
 * page loaded. Returns the unsubscribe function.
 */
export const onNativeCompose = (handler: (text: string) => void): UnlistenFunction =>
    onNativePending((listener) => getNative()?.onCompose(listener), takePendingCompose, handler);

/**
 * Calls `handler` with the text of every `neore://new?text=` link, including one that arrived before the page
 * loaded. The text is for the composer to show and the user to send: a link never sends it.
 */
export const onNativeDraft = (handler: (text: string) => void): UnlistenFunction =>
    onNativePending((listener) => getNative()?.onDraft?.(listener), takePendingDraft, handler);

/** A system-browser sign-in the shell received: the code, and the verifier that proves this app started it. */
export interface NativeSignIn {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

/** Only a shell that advertises `sign-in` has the flow; anywhere else every sign-in call is a no-op. */
const getSignInBridge = (): NativeBridge | undefined => {
    const native = getNative();

    return native?.capabilities.includes("sign-in") ? native : undefined;
};

/** Takes (and clears) the sign-in the shell is holding for this page, if any. */
export const takePendingSignIn = async (): Promise<NativeSignIn | undefined> => {
    try {
        const signIn = await getSignInBridge()?.takePendingSignIn();

        return signIn ?? undefined;
    } catch {
        return undefined;
    }
};

/**
 * Calls `handler` with each browser sign-in the shell receives, including one
 * that arrived before the page subscribed. Returns the unsubscribe function.
 */
export const onNativeSignIn = (handler: (signIn: NativeSignIn) => void): UnlistenFunction =>
    onNativePending((listener) => getSignInBridge()?.onSignIn(listener), takePendingSignIn, handler);

/** Opens the system browser on the sign-in page (the shell does the same when Google is opened in the window). */
export const startNativeBrowserSignIn = async (): Promise<void> => {
    try {
        await getSignInBridge()?.startBrowserSignIn();
    } catch {
        // Best-effort: the browser did not open; the user can sign in another way.
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

// ─── Device execution ───────────────────────────────────────────────────────
//
// The shell's relay: the main process (`registerDeviceIpc`), the preload's `deviceRelay`, and
// the Rust core. Each function forwards to it when the shell advertises `device`, and answers
// "not available" otherwise, so the devices UI shows pairing as unavailable instead of failing a
// call. The page only relays signed envelopes; the core verifies them and asks the user locally.

export type NativeDevicePlatform = "linux" | "macos" | "windows";

/** A server this computer speaks for, and whether the shell is connected to it right now. */
export interface NativeHostStatus {
    connected: boolean;
    deviceId: string;
    name: string;
}

export interface NativeDeviceStatus {
    accountLabel?: string | null;
    /** The backend device this shell is paired as; absent when unpaired. */
    deviceId?: string | null;
    /** The servers reached over SSH that this shell holds the secrets of. Absent from an older shell. */
    hosts?: NativeHostStatus[];
    platform: NativeDevicePlatform;
}

/** Where a server is and how to log in. The shell validates it and asks the user before anything connects. */
export interface NativeHostSpec {
    address: string;
    identityFile?: string;
    name: string;
    port?: number;
    user: string;
}

/** What a connected server reported about itself. */
export interface NativeHostProbe {
    platform: NativeDevicePlatform;
    sandboxAvailable: boolean;
    sandboxDetail: string;
    version: string;
}

/** A payload and its HMAC, exactly as the shell or the backend signed it. */
export interface NativeSigned {
    payload: string;
    signature: string;
}

/** Only a shell that advertises `device` has the relay; anywhere else every device call is inert. */
const getDeviceBridge = (): NativeDeviceRelay | undefined => {
    const native = getNative();
    const relay = native?.capabilities.includes("device") ? native.device : undefined;

    return relay !== undefined && typeof relay.execute === "function" ? relay : undefined;
};

/** `undefined` until the shell advertises `device`; also `undefined` when the core failed to load. */
export const getNativeDeviceStatus = async (): Promise<NativeDeviceStatus | undefined> => {
    try {
        return (await getDeviceBridge()?.status()) ?? undefined;
    } catch {
        return undefined;
    }
};

/** `false` until the shell advertises `device`, and when the shell refuses the pairing. */
export const pairNativeDevice = async (pairing: { accountLabel: string; deviceId: string; secret: string }): Promise<boolean> => {
    try {
        return (await getDeviceBridge()?.pair(pairing)) === true;
    } catch {
        return false;
    }
};

/** `undefined` until the shell advertises `device`. With a device id: that server's manifest, signed with its own secret. */
export const getNativeDeviceManifest = async (deviceId?: string): Promise<NativeSigned | undefined> => getDeviceBridge()?.manifest(deviceId);

/**
 * Connects a server that is not paired yet. The shell asks the user to trust its key on first use and for a key
 * passphrase, in its own window. Rejects with the reason when it cannot connect.
 */
export const probeNativeHost = async (spec: NativeHostSpec): Promise<NativeHostProbe> => {
    const relay = getDeviceBridge();

    if (relay === undefined) {
        throw new Error("This desktop app cannot connect to servers");
    }

    return relay.hostProbe(spec);
};

/** Stores the probed server with the secret the backend minted for it. `false` when the user declined in the shell. */
export const pairNativeHost = async (pairing: { deviceId: string; secret: string; spec: NativeHostSpec }): Promise<boolean> => {
    try {
        return (await getDeviceBridge()?.hostPair(pairing)) === true;
    } catch {
        return false;
    }
};

/** Connects a paired server again. Rejects with the reason (a changed host key, a refused login…). */
export const connectNativeHost = async (deviceId: string): Promise<NativeHostProbe | undefined> => getDeviceBridge()?.hostConnect(deviceId);

export const disconnectNativeHost = async (deviceId: string): Promise<void> => {
    try {
        await getDeviceBridge()?.hostDisconnect(deviceId);
    } catch {
        // Already gone.
    }
};

/** Rejects until the shell advertises `device`; otherwise the shell's own rejection reaches the caller. */
export const executeOnNativeDevice = async (call: { envelope: string; signature: string }): Promise<NativeSigned> => {
    const relay = getDeviceBridge();

    if (relay === undefined) {
        throw new Error("This desktop app has no device execution yet");
    }

    return relay.execute(call);
};

/** Opens the shell's local window. A no-op until the shell advertises `device`. */
export const openNativeDeviceSettings = async (): Promise<void> => {
    try {
        await getDeviceBridge()?.openSettings();
    } catch {
        // The window did not open; the user can still open it from the shell's menu.
    }
};

/** A signed "prompting" / "running" report for one call, relayed as-is to `reportDeviceCallProgress`. */
export interface NativeDeviceProgress extends NativeSigned {
    callId: string;
    /** The device the report is for: this computer, or a server it speaks for. */
    deviceId: string;
}

/** Signed progress reports for calls this page relayed; a no-op until the shell advertises `device`. */
export const onNativeDeviceProgress = (handler: (report: NativeDeviceProgress) => void): UnlistenFunction =>
    getDeviceBridge()?.onProgress(handler) ?? (() => {});

/** Calls `handler` once on subscribe, then on each shell change; only the one call outside the shell. */
export const onNativeDeviceChanged = (handler: () => void): UnlistenFunction => {
    handler();

    return getDeviceBridge()?.onChanged(handler) ?? (() => {});
};
