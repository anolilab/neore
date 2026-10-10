/**
 * The extension manifest, for either browser.
 *
 * Pure (no `chrome.*`, no Vite) so both variants are unit-tested, and so
 * `manifest.config.ts` stays a thin adapter from the build's env to this.
 *
 * What differs for Firefox, and why:
 *
 * - `background.scripts`, not `service_worker` — Firefox MV3 runs background
 *   scripts as an event page and does not support `service_worker`.
 * - `sidebar_action` instead of `side_panel`/`sidePanel` — Firefox's sidebar API.
 * - `identity` — sign-in runs through `identity.launchWebAuthFlow`, because the
 *   Firefox build cannot use the web app's session cookie (see
 *   `src/lib/extension-grant.ts`). For the same reason it needs no host
 *   permission for the app origin: it never fetches it.
 * - `browser_specific_settings.gecko` — a fixed add-on id (required to sign an
 *   MV3 add-on, and what the sign-in redirect URI is derived from) plus the
 *   data-collection declaration AMO requires of new submissions.
 */
/* eslint-disable perfectionist/sort-objects -- manifest keys follow the order of the browser's manifest documentation, which is how the emitted manifest.json reads */
import type { ManifestV3Export } from "@crxjs/vite-plugin";

export type TargetBrowser = "chrome" | "firefox";

/**
 * The add-on id. `identity.getRedirectURL()` is derived from it, so changing it
 * changes the redirect URI the backend must list in
 * `TRUSTED_EXTENSION_REDIRECT_URIS`.
 */
export const GECKO_ID = "anole-chat@neore.ai";

/**
 * `data_collection_permissions` needs Firefox 140 (desktop); `storage.session`,
 * `scripting` and MV3 host-permission prompts are all older.
 */
export const FIREFOX_MIN_VERSION = "140.0";

export const SIDEBAR_PATH = "src/sidepanel/index.html";
export const BACKGROUND_PATH = "src/background/index.ts";

export interface ManifestInput {
    appUrl: string;
    browser: TargetBrowser;
    /** Vite's command: the CSP is added to builds only. */
    command: "build" | "serve";
    description: string;
    gatewayUrl?: string;
    lunoraUrl?: string;
    name: string;
    version: string;
}

/** `https://host:port/*` for a configured origin, or nothing when it is unset or unparsable. */
export const toMatchPattern = (value: string | undefined): string | undefined => {
    if (!value) {
        return undefined;
    }

    try {
        const { host, protocol } = new URL(value);

        return `${protocol}//${host}/*`;
    } catch {
        return undefined;
    }
};

const originOf = (value: string | undefined): string | undefined => {
    try {
        return value ? new URL(value).origin : undefined;
    } catch {
        return undefined;
    }
};

const present = <T>(value: T | undefined): value is T => value !== undefined;

const HTTP_SCHEME = /^http/;

type Manifest = Extract<ManifestV3Export, { manifest_version: number }>;

/** The crxjs manifest type plus the Firefox key it does not declare. */
export type ExtensionManifest = Manifest & {
    sidebar_action?: {
        default_icon?: Record<number, string>;
        default_panel: string;
        default_title?: string;
        open_at_install?: boolean;
    };
};

export const buildManifest = (input: ManifestInput): ExtensionManifest => {
    const isFirefox = input.browser === "firefox";

    // Host access is limited to our own origins: the Lunora backend (RPC) and the
    // LLM gateway (chat start + stream), plus — Chrome only — the app, where
    // better-auth's session cookie lives. Nothing else is ever fetched, and page
    // content is read through `activeTab` + `scripting`, which needs no host
    // permission at all — so there is no `<all_urls>` and no persistent content
    // script. In Firefox these grants are also what exempt the extension's
    // requests from CORS, which is why that build needs no origin allow-listing
    // on the backend.
    const configured = [isFirefox ? undefined : input.appUrl, input.lunoraUrl, input.gatewayUrl];
    const hostPermissions = [...new Set(configured.map((value) => toMatchPattern(value)).filter(present))];

    // `connect-src` repeats that list so a compromised dependency cannot exfiltrate
    // to anywhere else. The Lunora client also speaks WebSocket to the backend.
    const origins = [...new Set(configured.map((value) => originOf(value)).filter(present))];
    const socketOrigins = origins.map((origin) => origin.replace(HTTP_SCHEME, "ws"));
    const connectSources = ["'self'", ...origins, ...socketOrigins].join(" ");

    // activeTab + scripting: read the CURRENT tab only, only after the user
    // invokes the extension on it (toolbar, context menu, shortcut).
    // contextMenus: the page/selection actions. storage: settings and the
    // background -> panel hand-off. sidePanel / identity: see the file header.
    const permissions = ["activeTab", "contextMenus", "scripting", isFirefox ? "identity" : "sidePanel", "storage"].toSorted((a, b) => a.localeCompare(b));

    const manifest: ExtensionManifest = {
        manifest_version: 3,
        name: input.name,
        description: input.description,
        version: input.version,
        icons: { 48: "public/logo.png" },
        action: {
            default_icon: { 48: "public/logo.png" },
            default_title: "Open Anole Chat",
        },
        permissions: permissions as Manifest["permissions"],
        host_permissions: hostPermissions,
        commands: {
            "open-side-panel": {
                description: "Open Anole Chat",
                suggested_key: { default: "Alt+Shift+K", mac: "Alt+Shift+K" },
            },
            "chat-with-page": {
                description: "Chat with the current page",
                suggested_key: { default: "Alt+Shift+P", mac: "Alt+Shift+P" },
            },
        },
        // Build only: `vite dev` serves the pages from its own server over HMR,
        // which this policy would (correctly) refuse to connect to.
        ...(input.command === "build" && {
            content_security_policy: {
                // 'wasm-unsafe-eval' is for the syntax highlighter's regex engine in
                // rendered code blocks; no 'unsafe-eval', no remote script.
                extension_pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src ${connectSources}`,
            },
        }),
    };

    if (!isFirefox) {
        return {
            ...manifest,
            minimum_chrome_version: "116",
            background: { service_worker: BACKGROUND_PATH, type: "module" },
            side_panel: { default_path: SIDEBAR_PATH },
        };
    }

    return {
        ...manifest,
        // crxjs emits the loader as `{ scripts: [loader], type: 'module' }`.
        background: { scripts: [BACKGROUND_PATH] },
        sidebar_action: {
            default_icon: { 48: "public/logo.png" },
            default_panel: SIDEBAR_PATH,
            default_title: "Anole Chat",
            open_at_install: false,
        },
        browser_specific_settings: {
            gecko: {
                id: GECKO_ID,
                strict_min_version: FIREFOX_MIN_VERSION,
                // What leaves the browser, and only on the user's action: their
                // sign-in (authenticationInfo), their chats (personalCommunications)
                // and the page or selection they choose to share (websiteContent).
                data_collection_permissions: {
                    required: ["authenticationInfo", "personalCommunications", "websiteContent"],
                },
            },
        },
    };
};
