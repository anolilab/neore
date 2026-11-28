import { useSyncExternalStore } from "react";

import { APP_MANIFEST_HREF, getInstallPromptFor, getServerInstallPrompt, hasInstalledHref, installApp, subscribeInstallPrompt } from "./install-prompt-store";

export interface InstallApp {
    canInstall: boolean;
    install: () => Promise<void>;
    installed: boolean;
}

const STANDALONE_QUERY = "(display-mode: standalone)";

const isRunningInstalled = (): boolean => {
    // iOS Safari reports standalone on navigator, not through display-mode.
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;

    return iosStandalone || globalThis.matchMedia(STANDALONE_QUERY).matches;
};

const subscribeInstalled = (onChange: () => void): (() => void) => {
    const query = globalThis.matchMedia(STANDALONE_QUERY);

    query.addEventListener("change", onChange);

    return () => {
        query.removeEventListener("change", onChange);
    };
};

const notInstalledOnServer = (): boolean => false;

/**
 * Lets a page offer an install as a button. `manifestHref` is the manifest this button installs; a prompt
 * offered for another manifest is never shown. Running standalone counts as installed only for the Neore
 * app itself: a page app window must not hide Neore's button, and Neore's window must not hide a page's.
 */
export const useInstallApp = (manifestHref: string): InstallApp => {
    const runningInstalled = useSyncExternalStore(subscribeInstalled, isRunningInstalled, notInstalledOnServer);
    const installedHere = useSyncExternalStore(subscribeInstallPrompt, () => hasInstalledHref(manifestHref), notInstalledOnServer);
    const promptEvent = useSyncExternalStore(subscribeInstallPrompt, () => getInstallPromptFor(manifestHref), getServerInstallPrompt);
    const installed = installedHere || (manifestHref === APP_MANIFEST_HREF && runningInstalled);

    return {
        canInstall: promptEvent !== null && !installed,
        install: () => installApp(manifestHref),
        installed,
    };
};
