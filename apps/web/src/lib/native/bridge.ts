/**
 * The web side of the desktop shell in `apps/desktop` (Electron). Every export
 * is a NO-OP outside it, so callers need no platform check of their own.
 *
 * The shell's preload exposes `window.neoreNative` on the site origin only, and
 * it lists in `capabilities` what this build can do. Anything not listed here
 * (sign-in in the system browser, device execution) is inert until its port
 * lands; see `docs/plans/desktop-and-mobile-apps.md` §4.
 */

type UnlistenFunction = () => void;

/** What the Electron preload exposes (`apps/desktop/src/preload.ts`). */
interface NativeBridge {
    capabilities: ReadonlyArray<string>;
    notify: (title: string, body?: string) => Promise<void>;
    onCompose: (handler: () => void) => UnlistenFunction;
    onSignIn: (handler: () => void) => UnlistenFunction;
    startBrowserSignIn: () => Promise<void>;
    takePendingCompose: () => Promise<string | undefined>;
    takePendingSignIn: () => Promise<NativeSignIn | undefined>;
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

/** Takes (and clears) the text the shell is holding for a new chat, if any. */
export const takePendingCompose = async (): Promise<string | undefined> => {
    try {
        const text = await getNative()?.takePendingCompose();

        return typeof text === "string" && text.trim() !== "" ? text : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Calls `handler` with every text the shell hands over (Quick Composer, a
 * `neore://new?text=` link, a share), including one that arrived before the
 * page loaded. Returns the unsubscribe function.
 */
export const onNativeCompose = (handler: (text: string) => void): UnlistenFunction => {
    const native = getNative();

    if (!native) {
        return () => {};
    }

    let disposed = false;

    const drain = async () => {
        const text = await takePendingCompose();

        if (text !== undefined && !disposed) {
            handler(text);
        }
    };

    const stop = native.onCompose(() => drain());

    void drain();

    return () => {
        disposed = true;
        stop();
    };
};

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
export const onNativeSignIn = (handler: (signIn: NativeSignIn) => void): UnlistenFunction => {
    const native = getSignInBridge();

    if (!native) {
        return () => {};
    }

    let disposed = false;

    const drain = async () => {
        const signIn = await takePendingSignIn();

        if (signIn !== undefined && !disposed) {
            handler(signIn);
        }
    };

    const stop = native.onSignIn(() => drain());

    void drain();

    return () => {
        disposed = true;
        stop();
    };
};

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
// Not in the Electron shell yet (the Rust core is being ported; see the plan's
// step 3). Every function below answers "not available" and advertises nothing,
// so the devices UI shows pairing as unavailable instead of failing a call.
// The contract (the page only relays signed envelopes) is unchanged for when it lands.

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

/** `undefined` until the shell advertises `device`. */
export const getNativeDeviceStatus = async (): Promise<NativeDeviceStatus | undefined> => undefined;

/** `false` until the shell advertises `device`. */
export const pairNativeDevice = async (_pairing: { accountLabel: string; deviceId: string; secret: string }): Promise<boolean> => false;

/** `undefined` until the shell advertises `device`. */
export const getNativeDeviceManifest = async (): Promise<NativeSigned | undefined> => undefined;

/** Rejects until the shell advertises `device`. */
export const executeOnNativeDevice = async (_call: { envelope: string; signature: string }): Promise<NativeSigned> => {
    throw new Error("This desktop app has no device execution yet");
};

/** Opens the shell's local window. A no-op until the shell advertises `device`. */
export const openNativeDeviceSettings = async (): Promise<void> => {};

/** A signed "prompting" / "running" report for one call, relayed as-is to `reportDeviceCallProgress`. */
export interface NativeDeviceProgress extends NativeSigned {
    callId: string;
}

export const onNativeDeviceProgress =
    (_handler: (report: NativeDeviceProgress) => void): UnlistenFunction =>
    () => {};

/** Calls `handler` once on subscribe; no further events until the shell advertises `device`. */
export const onNativeDeviceChanged = (handler: () => void): UnlistenFunction => {
    handler();

    return () => {};
};
