import { normalizeSearchText } from "./settings-search";

/** What a settings row calls itself: a form label, a heading or a card title. */
const ROW_TITLE_SELECTOR = 'label, legend, h1, h2, h3, h4, h5, h6, [role="heading"], [data-slot="card-title"], [data-slot="field-label"]';

const CARD_TITLE_SELECTOR = '[data-slot="card-title"]';
const FIELD_SELECTOR = '[data-slot="field"]';

export const HIGHLIGHT_DURATION_MS = 2000;
export const WAIT_FOR_ROW_MS = 4000;

const HIGHLIGHT_CLASSES = ["ring-2", "ring-primary", "ring-offset-2", "ring-offset-background", "rounded-lg", "transition-shadow"];

/** What gets scrolled to and ringed for a title: a card for a card title, else its field, else the title's own wrapper. */
const rowOf = (title: HTMLElement): HTMLElement => {
    if (title.matches(CARD_TITLE_SELECTOR)) {
        return title.closest<HTMLElement>('[data-slot="card"]') ?? title;
    }

    return title.closest<HTMLElement>(FIELD_SELECTOR) ?? title.parentElement ?? title;
};

/** The first element under `root` whose text is `label`, ignoring case and accents. */
export const findSettingsRow = (root: HTMLElement, label: string): HTMLElement | null => {
    const wanted = normalizeSearchText(label.trim());

    for (const candidate of root.querySelectorAll<HTMLElement>(ROW_TITLE_SELECTOR)) {
        if (normalizeSearchText((candidate.textContent ?? "").trim()) === wanted) {
            return rowOf(candidate);
        }
    }

    return null;
};

/**
 * Scrolls the row titled `label` into view once the tab has rendered it (tabs are lazy-loaded, so it may not exist yet)
 * and rings it for two seconds. A row that never appears is not an error: the tab stays open at the top.
 * Returns a function that cancels the wait and removes the highlight.
 */
export const jumpToSettingsRow = (root: HTMLElement, label: string): (() => void) => {
    let observer: MutationObserver | undefined;
    let highlighted: HTMLElement | null = null;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

    const clear = (): void => {
        highlighted?.classList.remove(...HIGHLIGHT_CLASSES);
        highlighted = null;
    };

    const reveal = (): void => {
        const row = findSettingsRow(root, label);

        if (!row) {
            return;
        }

        observer?.disconnect();
        clearTimeout(giveUpTimer);
        row.scrollIntoView({ block: "center" });
        row.classList.add(...HIGHLIGHT_CLASSES);
        highlighted = row;
        highlightTimer = setTimeout(clear, HIGHLIGHT_DURATION_MS);
    };

    observer = new MutationObserver(reveal);
    observer.observe(root, { childList: true, subtree: true });
    giveUpTimer = setTimeout(() => observer?.disconnect(), WAIT_FOR_ROW_MS);
    reveal();

    return () => {
        observer?.disconnect();
        clearTimeout(giveUpTimer);
        clearTimeout(highlightTimer);
        clear();
    };
};
