/**
 * The browser this build targets, fixed at build time by `vite.config.ts`
 * (`TARGET_BROWSER=firefox` → the `build:firefox` script).
 *
 * The two builds differ in how they authenticate: Chrome shares the web app's
 * session cookie (`lib/auth.ts`, with the extension's exact origin trusted by
 * the backend); Firefox cannot — every install has its own random
 * `moz-extension://` origin — so it signs in through `identity.launchWebAuthFlow`
 * and holds a bearer grant instead (`lib/extension-grant.ts`).
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
