import { ACCENT_IDS, DEFAULT_ACCENT } from "./accent-presets";
import { CONTRAST_ATTRIBUTE, DEFAULT_DENSITY, DEFAULT_MAIN_FONT, DENSITY_ATTRIBUTE, DENSITY_IDS, FONT_ATTRIBUTE, MAIN_FONT_IDS } from "./display-preferences";
import { SYSTEM_ACCENT, SYSTEM_ACCENT_CACHE_KEY, SYSTEM_ACCENT_PROPERTIES } from "./native-appearance";

/** The `persist` key of `useUIStateStore` (`features/layout/stores/ui-state-store.ts`). */
export const UI_STATE_STORAGE_KEY = "neore-ui-state";

export const ACCENT_ATTRIBUTE = "data-accent";

/** Each appearance value that reaches the DOM: the stored key, its allow-list, and the value that leaves the default tokens in place. */
const BOOT_ATTRIBUTES = [
    { attribute: ACCENT_ATTRIBUTE, fallback: DEFAULT_ACCENT, ids: ACCENT_IDS, key: "accentColor" },
    { attribute: DENSITY_ATTRIBUTE, fallback: DEFAULT_DENSITY, ids: DENSITY_IDS, key: "density" },
    { attribute: FONT_ATTRIBUTE, fallback: DEFAULT_MAIN_FONT, ids: MAIN_FONT_IDS, key: "mainFont" },
] as const;

/** On `<html>` inside the desktop shell, and when its window has macOS vibrancy behind it. */
export const NATIVE_ATTRIBUTE = "data-native";
export const NATIVE_VIBRANCY_ATTRIBUTE = "data-native-vibrancy";

/**
 * The desktop shell, before first paint (the preload installs `window.neoreNative` before any page script):
 * `data-native` (and `data-native-vibrancy`) for the native CSS, spellcheck off by default (prose editors opt back
 * in), the system font for an untouched default font, and the OS accent (cached from the last run) for an
 * untouched default accent or a stored `system`. Mirrors `effectiveAccent` / `effectiveMainFont`.
 *
 * It runs in its own `try`, with `a` (the stored appearance) left `{}` when storage is corrupt or throws, so the
 * shell marks still land. Every cached token must be `#rrggbb` before any of them is written.
 */
const NATIVE_BOOT = [
    "try{var n=window.neoreNative;",
    "if(n){",
    "var d=document.documentElement;var p=Array.isArray(n.capabilities)?n.capabilities:[];var x=a.explicit||{};",
    `d.setAttribute(${JSON.stringify(NATIVE_ATTRIBUTE)},"");`,
    `if(p.indexOf("vibrancy")!==-1){d.setAttribute(${JSON.stringify(NATIVE_VIBRANCY_ATTRIBUTE)},"")}`,
    'd.setAttribute("spellcheck","false");',
    `if(!x.mainFont&&(a.mainFont===undefined||a.mainFont===${JSON.stringify(DEFAULT_MAIN_FONT)})){d.setAttribute(${JSON.stringify(FONT_ATTRIBUTE)},"system")}`,
    `var ac=a.accentColor;if(p.indexOf("system-accent")!==-1&&(ac===${JSON.stringify(SYSTEM_ACCENT)}||(!x.accentColor&&(ac===undefined||ac===${JSON.stringify(DEFAULT_ACCENT)})))){`,
    `var t=JSON.parse(localStorage.getItem(${JSON.stringify(SYSTEM_ACCENT_CACHE_KEY)})||"null");`,
    `var h=/^#[0-9a-f]{6}$/;var q=${JSON.stringify(SYSTEM_ACCENT_PROPERTIES)};var ok=!!t&&typeof t==="object";`,
    "for(var r in q){if(ok&&!h.test(t[r])){ok=false}}",
    "if(ok){",
    "for(var r in q){d.style.setProperty(q[r],t[r])}",
    `d.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},${JSON.stringify(SYSTEM_ACCENT)})`,
    "}}}}catch(e){}",
].join("");

/**
 * Inline `<head>` script that puts the stored accent, density and font on
 * `<html>` BEFORE first paint, the way next-themes applies the theme class: the
 * store only rehydrates after the JS bundle runs, which would flash the default
 * first. Rendered through the root route's `head().scripts`, so it carries the
 * CSP nonce.
 *
 * Only a known id from the allow-list is ever written into the DOM; anything
 * else in storage (or no storage at all) leaves the default tokens in place.
 */
export const ACCENT_BOOT_SCRIPT = `(function(){var a={};try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(UI_STATE_STORAGE_KEY)})||"null");a=s&&s.state&&s.state.appearance||{};var c=${JSON.stringify(BOOT_ATTRIBUTES)};for(var i=0;i<c.length;i++){var m=c[i];var v=a[m.key];if(v!==m.fallback&&m.ids.indexOf(v)!==-1){document.documentElement.setAttribute(m.attribute,v)}}var k=a.contrast;if(k==="high"||(k!=="standard"&&window.matchMedia&&window.matchMedia("(prefers-contrast: more)").matches)){document.documentElement.setAttribute("data-contrast","high")}}catch(e){}${NATIVE_BOOT}})();`;

/** The runtime twin of the contrast part of the boot script. */
export const applyContrastAttribute = (value: "high" | undefined, root: HTMLElement = document.documentElement): void => {
    if (value === undefined) {
        root.removeAttribute(CONTRAST_ATTRIBUTE);

        return;
    }

    root.setAttribute(CONTRAST_ATTRIBUTE, value);
};

/** The runtime twin of the boot script: the fallback value removes the attribute so the default tokens apply untouched. */
export const applyRootAttribute = (attribute: string, value: string, fallback: string, root: HTMLElement = document.documentElement): void => {
    if (value === fallback) {
        root.removeAttribute(attribute);

        return;
    }

    root.setAttribute(attribute, value);
};

export const applyAccentAttribute = (accent: string, root: HTMLElement = document.documentElement): void => {
    applyRootAttribute(ACCENT_ATTRIBUTE, accent, DEFAULT_ACCENT, root);
};
