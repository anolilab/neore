/**
 * The browser this build targets, fixed at build time by `vite.config.ts`
 * (`TARGET_BROWSER=firefox` → the `build:firefox` script).
 *
 * Both builds sign in the same way, through `identity.launchWebAuthFlow` and a
 * bearer grant (`lib/extension-grant.ts`); they differ in the side panel API.
 */
export const IS_FIREFOX = import.meta.env.VITE_TARGET_BROWSER === "firefox";

/**
 * The Firefox-only APIs this extension calls. `@types/chrome` does not declare
 * them — it types `browser` as `chrome` — and Chrome 148+ has a `browser`
 * namespace WITHOUT them, so every member is optional and feature-detected.
 */
interface FirefoxBrowser {
    commands?: {
        /** Firefox 137+: opens about:addons' shortcut editor, which `tabs.create` may not. */
        openShortcutSettings: () => Promise<void>;
    };
    sidebarAction?: {
        /** Only from a user-action handler (toolbar, menu, command), and synchronously. */
        open: () => Promise<void>;
        toggle: () => Promise<void>;
    };
}

/** The `browser` namespace, when there is one. */
export const firefoxBrowser = (): FirefoxBrowser | undefined => (globalThis as unknown as { browser?: FirefoxBrowser }).browser;
