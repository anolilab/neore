import { captureException } from "@/lib/analytics/posthog-client";

// lib.dom does not type the install prompt. Chromium and Edge fire it; Safari and Firefox never do.
export interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
}

/** The manifest of the Neore app itself (`__root.tsx`). A page's install uses its own manifest href. */
export const APP_MANIFEST_HREF = "/manifest.json";

/** The document's manifest link. Pages swap its href (`features/pages/hooks/use-page-manifest-link.ts`), so both read it through this selector. */
export const MANIFEST_LINK_SELECTOR = 'link[rel="manifest"]';

/** The manifest the document points at right now. Chromium reads this link when it decides what to install. */
const currentManifestHref = (): string => document.querySelector(MANIFEST_LINK_SELECTOR)?.getAttribute("href") ?? APP_MANIFEST_HREF;

// The browser fires `beforeinstallprompt` once for each manifest it reads, often before any component
// mounts. The listeners therefore live here, attached when the module loads, not in a component that
// might mount too late to see it.
//
// A prompt is kept with the manifest href it was offered for. A page swaps the link's href while it is
// mounted, and the browser fires a new prompt for each swap, so the newest one replaces the last.
//
// `installedHrefs` records which manifest was installed. A page app and the Neore app have different
// ids, so one installed must not hide the other's button.
const state: {
    deferredHref: string | null;
    deferredPrompt: BeforeInstallPromptEvent | null;
    installedHrefs: Set<string>;
} = { deferredHref: null, deferredPrompt: null, installedHrefs: new Set() };
const listeners = new Set<() => void>();

const notify = (): void => {
    for (const listener of listeners) {
        listener();
    }
};

const handleBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault();
    state.deferredPrompt = event as BeforeInstallPromptEvent;
    state.deferredHref = currentManifestHref();
    notify();
};

const handleAppInstalled = (): void => {
    state.installedHrefs.add(currentManifestHref());
    state.deferredPrompt = null;
    state.deferredHref = null;
    notify();
};

// Workers define `globalThis.addEventListener` too, so the check is for the document, which only a browser has.
if (typeof document !== "undefined") {
    globalThis.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    globalThis.addEventListener("appinstalled", handleAppInstalled);
}

export const subscribeInstallPrompt = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

/**
 * The captured prompt, but only while it matches `manifestHref` three ways: it was captured under that href,
 * the document still points at it, and the caller asked for it. A prompt captured under a manifest the link
 * has since moved away from would install the wrong app.
 */
export const getInstallPromptFor = (manifestHref: string): BeforeInstallPromptEvent | null =>
    state.deferredHref === manifestHref && currentManifestHref() === manifestHref ? state.deferredPrompt : null;

export const getServerInstallPrompt = (): null => null;

export const hasInstalledHref = (manifestHref: string): boolean => state.installedHrefs.has(manifestHref);

/**
 * Shows the browser's install dialog. A deferred prompt can be shown once, so it is cleared
 * before the call. A browser that refuses to show it is reported, not thrown into the click handler.
 */
export const installApp = async (manifestHref: string): Promise<void> => {
    const event = getInstallPromptFor(manifestHref);

    if (!event) {
        return;
    }

    state.deferredPrompt = null;
    state.deferredHref = null;
    notify();

    try {
        await event.prompt();
    } catch (error) {
        captureException(error, { context: "install_app_prompt" });
    }
};
