/**
 * The thread list's search, as the Focus Search shortcut reaches it. The input is only
 * mounted while the search bar is open, so a closed bar is opened through the header's
 * toggle. With neither on the page (the sidebar is closed) there is nothing to focus and
 * the shortcut must leave the keystroke to the browser's find.
 */
export const SEARCH_INPUT_SELECTOR = "[data-search-input]";
export const SEARCH_TOGGLE_SELECTOR = "[data-search-toggle]";

// A collapsed sidebar stays mounted and slides off-canvas, which `checkVisibility` still calls visible.
const COLLAPSED_SIDEBAR_SELECTOR = '[data-slot="sidebar"][data-state="collapsed"]';

const findVisible = <T extends HTMLElement>(selector: string): T | undefined => {
    for (const element of document.querySelectorAll<T>(selector)) {
        // `checkVisibility` is absent in older engines; assume visible there.
        if (element.checkVisibility?.({ visibilityProperty: true }) !== false && !element.closest(COLLAPSED_SIDEBAR_SELECTOR)) {
            return element;
        }
    }

    return undefined;
};

export const hasThreadSearchTarget = (): boolean =>
    findVisible<HTMLInputElement>(SEARCH_INPUT_SELECTOR) !== undefined || findVisible<HTMLButtonElement>(SEARCH_TOGGLE_SELECTOR) !== undefined;

/** Focuses the search input, opening the search bar first when it is closed. False when the page has no thread search. */
export const focusThreadSearch = (): boolean => {
    let input = findVisible<HTMLInputElement>(SEARCH_INPUT_SELECTOR);

    if (!input) {
        // A click is a discrete event, so React has rendered the open bar by the time it returns.
        findVisible<HTMLButtonElement>(SEARCH_TOGGLE_SELECTOR)?.click();
        input = findVisible<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
    }

    if (!input) {
        return false;
    }

    input.focus();
    input.select();

    return true;
};
