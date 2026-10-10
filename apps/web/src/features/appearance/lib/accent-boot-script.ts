import { ACCENT_IDS, DEFAULT_ACCENT } from "./accent-presets";

/** The `persist` key of `useUIStateStore` (`features/layout/stores/ui-state-store.ts`). */
export const UI_STATE_STORAGE_KEY = "neore-ui-state";

export const ACCENT_ATTRIBUTE = "data-accent";

/**
 * Inline `<head>` script that puts the stored accent on `<html>` BEFORE first
 * paint, the way next-themes applies the theme class: the store only rehydrates
 * after the JS bundle runs, which would flash the default lime first. Rendered
 * through the root route's `head().scripts`, so it carries the CSP nonce.
 *
 * Only a known preset id is ever written into the DOM; anything else in
 * storage (or no storage at all) leaves the default tokens in place.
 */
export const ACCENT_BOOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(UI_STATE_STORAGE_KEY)})||"null");var a=s&&s.state&&s.state.appearance&&s.state.appearance.accentColor;if(a!==${JSON.stringify(DEFAULT_ACCENT)}&&${JSON.stringify(ACCENT_IDS)}.indexOf(a)!==-1){document.documentElement.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},a)}}catch(e){}})();`;

/** The runtime twin of the boot script: `default` removes the attribute so global.css applies untouched. */
export const applyAccentAttribute = (accent: string, root: HTMLElement = document.documentElement): void => {
    if (accent === DEFAULT_ACCENT) {
        root.removeAttribute(ACCENT_ATTRIBUTE);

        return;
    }

    root.setAttribute(ACCENT_ATTRIBUTE, accent);
};
