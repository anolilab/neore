/** IPC channel names shared by the main process and the preloads. */
export const CHANNEL = {
    closeQuickComposer: "neore:close-quick-composer",
    compose: "neore:compose",
    notify: "neore:notify",
    /** Quick Composer only: its own page sends these, nothing else. */
    quickCompose: "neore:quick-compose",
    signIn: "neore:sign-in",
    startBrowserSignIn: "neore:start-browser-sign-in",
    takePendingCompose: "neore:take-pending-compose",
    takePendingSignIn: "neore:take-pending-sign-in",
} as const;

/** Passed to the site preload as `--neore-site-origin=` plus the site origin, so it exposes the bridge only on the site. */
export const SITE_ORIGIN_ARG = "--neore-site-origin=";

/** Passed to the site preload as `--neore-capabilities=a,b`: exactly what this build can do, decided by the main process. */
export const CAPABILITIES_ARG = "--neore-capabilities=";
