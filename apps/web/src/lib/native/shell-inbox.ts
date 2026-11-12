/**
 * What the desktop shell hands the page: application-menu commands, Quick Composer text, `neore://` drafts, files
 * dropped on the dock icon, and system-browser sign-ins. Apart from `bridge.ts` so the web build's first load never
 * carries it: only `native-bridge.tsx`, which the root loads lazily inside the shell, imports it. Every export is a
 * no-op outside the shell.
 */
import type { NativeBridge, NativeMenuCommand, NativeSignIn, UnlistenFunction } from "./bridge";
import { getNative, hasNativeCapability } from "./bridge";

const NATIVE_MENU_COMMANDS: ReadonlySet<string> = new Set<NativeMenuCommand>(["new-chat", "settings"]);

/** Calls `handler` with each application-menu command; unknown commands are dropped. A no-op without `menu-commands`. */
export const onNativeMenuCommand = (handler: (command: NativeMenuCommand) => void): UnlistenFunction => {
    if (!hasNativeCapability("menu-commands")) {
        return () => {};
    }

    return (
        getNative()?.onMenuCommand?.((command: string) => {
            if (NATIVE_MENU_COMMANDS.has(command)) {
                handler(command as NativeMenuCommand);
            }
        }) ?? (() => {})
    );
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
