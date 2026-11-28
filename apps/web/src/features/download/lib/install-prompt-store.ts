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
// Prompts are kept per manifest href. A page swaps the link's href while it is mounted, so the browser
// offers a prompt for each manifest it reads, and one manifest's offer must not replace another's: the
// app's offer has to survive a visit to a page.
//
// `pendingInstallHref` is the manifest whose prompt the user accepted. `appinstalled` can arrive after the
// link has moved on, so it is attributed to that manifest rather than to whatever the link points at now.
//
// `installedHrefs` records which manifest was installed. A page app and the Neore app have different
// ids, so one installed must not hide the other's button.
const state: {
    installedHrefs: Set<string>;
    pendingInstallHref: string | null;
    prompts: Map<string, BeforeInstallPromptEvent>;
} = { installedHrefs: new Set(), pendingInstallHref: null, prompts: new Map() };
const listeners = new Set<() => void>();

const notify = (): void => {
    for (const listener of listeners) {
        listener();
    }
};

const handleBeforeInstallPrompt = (event: Event): void => {
    const href = currentManifestHref();

    // A page is offered only by its in-app button, so the browser's own banner is suppressed for it. The Neore
    // app keeps the browser's banner on every route; its in-app button on /download uses the same prompt.
    if (href !== APP_MANIFEST_HREF) {
        event.preventDefault();
    }

    state.prompts.set(href, event as BeforeInstallPromptEvent);
    notify();
};

const handleAppInstalled = (): void => {
    const href = state.pendingInstallHref ?? currentManifestHref();

    state.installedHrefs.add(href);
    state.prompts.delete(href);
    state.pendingInstallHref = null;
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
 * The prompt captured for `manifestHref`, but only while the document still points at that manifest. A prompt
 * captured under a manifest the link has since moved away from would install the wrong app.
 */
export const getInstallPromptFor = (manifestHref: string): BeforeInstallPromptEvent | null => {
    const event = state.prompts.get(manifestHref) ?? null;

    return event !== null && currentManifestHref() === manifestHref ? event : null;
};

export const getServerInstallPrompt = (): null => null;

export const hasInstalledHref = (manifestHref: string): boolean => state.installedHrefs.has(manifestHref);

/**
 * Shows the browser's install dialog. A deferred prompt can be shown once, so it is taken out of the store
 * before the call. A browser that refuses to show it is reported, not thrown into the click handler.
 */
export const installApp = async (manifestHref: string): Promise<void> => {
    const event = getInstallPromptFor(manifestHref);

    if (!event) {
        return;
    }

    state.prompts.delete(manifestHref);
    state.pendingInstallHref = manifestHref;
    notify();

    try {
        await event.prompt();
    } catch (error) {
        captureException(error, { context: "install_app_prompt" });
    }
};
