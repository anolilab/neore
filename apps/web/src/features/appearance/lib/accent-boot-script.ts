import { ACCENT_IDS, DEFAULT_ACCENT } from "./accent-presets";
import { DEFAULT_DENSITY, DEFAULT_MAIN_FONT, DENSITY_ATTRIBUTE, DENSITY_IDS, FONT_ATTRIBUTE, MAIN_FONT_IDS } from "./display-preferences";

/** The `persist` key of `useUIStateStore` (`features/layout/stores/ui-state-store.ts`). */
export const UI_STATE_STORAGE_KEY = "neore-ui-state";

export const ACCENT_ATTRIBUTE = "data-accent";

/** Each appearance value that reaches the DOM: the stored key, its allow-list, and the value that leaves the default tokens in place. */
const BOOT_ATTRIBUTES = [
    { attribute: ACCENT_ATTRIBUTE, fallback: DEFAULT_ACCENT, ids: ACCENT_IDS, key: "accentColor" },
    { attribute: DENSITY_ATTRIBUTE, fallback: DEFAULT_DENSITY, ids: DENSITY_IDS, key: "density" },
    { attribute: FONT_ATTRIBUTE, fallback: DEFAULT_MAIN_FONT, ids: MAIN_FONT_IDS, key: "mainFont" },
] as const;

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
export const ACCENT_BOOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(UI_STATE_STORAGE_KEY)})||"null");var a=s&&s.state&&s.state.appearance||{};var c=${JSON.stringify(BOOT_ATTRIBUTES)};for(var i=0;i<c.length;i++){var m=c[i];var v=a[m.key];if(v!==m.fallback&&m.ids.indexOf(v)!==-1){document.documentElement.setAttribute(m.attribute,v)}}}catch(e){}})();`;

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
