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

export type UnlistenFunction = () => void;

/** A file the shell read from disk for the page; `File` is built from it here. */
export interface NativeDroppedFile {
    data: Uint8Array<ArrayBuffer>;
    name: string;
}

/** What the Electron preload exposes (`apps/desktop/src/preload.ts`). */
export interface NativeBridge {
    capabilities: ReadonlyArray<string>;
    device?: NativeDeviceRelay;
    /** The OS accent colour as `#rrggbb`, or `null` when the OS has none. Only with the `system-accent` capability. */
    getSystemAccentColor?: () => Promise<string | null>;
    notify: (title: string, body?: string) => Promise<void>;
    onCompose: (handler: () => void) => UnlistenFunction;
    /** A `neore://new?text=` link's text, for the composer to show and not send. Optional: older shells lack it. */
    onDraft?: (handler: () => void) => UnlistenFunction;
    /** Files dropped on the dock icon (macOS). Optional: older shells lack it. */
    onFiles?: (handler: () => void) => UnlistenFunction;
    /** Commands from the shell's application menu. Only with the `menu-commands` capability. */
    onMenuCommand?: (handler: (command: NativeMenuCommand) => void) => UnlistenFunction;
    onSignIn: (handler: () => void) => UnlistenFunction;
    /** Each change of the OS accent colour. Only with the `system-accent` capability. */
    onSystemAccentColor?: (handler: (hex: string | null) => void) => UnlistenFunction;
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
export interface NativeDeviceRelay {
    execute: (call: { envelope: string; signature: string }) => Promise<NativeSigned>;
    hostConnect: (deviceId: string) => Promise<NativeHostProbe>;
    hostDisconnect: (deviceId: string) => Promise<void>;
    hostPair: (pairing: { deviceId: string; secret: string; spec: NativeHostSpec }) => Promise<boolean>;
    hostProbe: (spec: NativeHostSpec) => Promise<NativeHostProbe>;
    manifest: (deviceId?: string) => Promise<NativeSigned & { appVersion?: string }>;
    onChanged: (handler: () => void) => UnlistenFunction;
    onProgress: (handler: (report: NativeDeviceProgress) => void) => UnlistenFunction;
    openSettings: () => Promise<void>;
    pair: (pairing: { accountLabel: string; deviceId: string; secret: string }) => Promise<boolean>;
    status: () => Promise<NativeDeviceStatus | null>;
}

/** A reply shorter than this finished while the user was probably still watching. */
export const LONG_REPLY_MS = 15_000;

/** The shell's preload API; `undefined` outside the desktop shell. */
export const getNative = (): NativeBridge | undefined => {
    const candidate = (globalThis as { neoreNative?: Partial<NativeBridge> }).neoreNative;

    return typeof candidate?.notify === "function" && typeof candidate.takePendingCompose === "function" && typeof candidate.onCompose === "function"
        ? (candidate as NativeBridge)
        : undefined;
};

export const isNativeShell = (): boolean => getNative() !== undefined;

/**
 * What the shell can do, from `capabilities` (`vibrancy`, `system-accent`, `menu-commands`, …). Known synchronously,
 * so the boot script and render code can branch on it; always `false` outside the shell.
 */
export const hasNativeCapability = (capability: string): boolean => getNative()?.capabilities.includes(capability) === true;

/** The commands the shell's application menu sends to the page. */
export type NativeMenuCommand = "new-chat" | "settings";

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

/** A system-browser sign-in the shell received: the code, and the verifier that proves this app started it. */
export interface NativeSignIn {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

// ─── Device execution ───────────────────────────────────────────────────────
//
// The shell's relay: the main process (`registerDeviceIpc`), the preload's `deviceRelay`, and
// the Rust core. Each function forwards to it when the shell advertises `device`, and answers
// "not available" otherwise, so the devices UI shows pairing as unavailable instead of failing a
// call. The page only relays signed envelopes; the core verifies them and asks the user locally.
// The types are here; the functions are in `device-bridge.ts`, off the first load.

export type NativeDevicePlatform = "linux" | "macos" | "windows";

/** Where the connection of a server the person connected stands when it is not simply up. */
export interface NativeHostReconnect {
    /** The attempt in the window, once one is scheduled or running. */
    attempt: number | null;
    maxAttempts: number;
    phase: "connecting" | "gaveUp" | "waiting";
    /** Why the last attempt failed: set while waiting or connecting after a failure, and when it gave up. Free text from ssh. */
    reason: string | null;
}

/** A server this computer speaks for, and whether the shell is connected to it right now. */
export interface NativeHostStatus {
    connected: boolean;
    deviceId: string;
    name: string;
    /** Set while the shell reconnects a lost connection, or after it gave up. Absent from an older shell. */
    reconnect?: NativeHostReconnect;
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

/** A signed "prompting" / "running" report for one call, relayed as-is to `reportDeviceCallProgress`. */
export interface NativeDeviceProgress extends NativeSigned {
    callId: string;
    /** The device the report is for: this computer, or a server it speaks for. */
    deviceId: string;
}
