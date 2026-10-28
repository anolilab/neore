import { normalizeSearchText } from "./settings-search";

/** What a settings row calls itself: a form label, a heading or a card title. */
const ROW_TITLE_SELECTOR = 'label, legend, h1, h2, h3, h4, h5, h6, [role="heading"], [data-slot="card-title"], [data-slot="field-label"]';

const CARD_SELECTOR = '[data-slot="card"]';
const CARD_TITLE_SELECTOR = '[data-slot="card-title"]';
const FIELD_SELECTOR = '[data-slot="field"]';

export const HIGHLIGHT_DURATION_MS = 2000;
/** How long a jump waits for a lazy tab to render its row before giving up. */
export const WAIT_FOR_ROW_MS = 15_000;
/** How long after the row first appears the jump keeps watching for content above it to shift it. */
export const SETTLE_MS = 300;

// An outline, not a ring: a card already draws its own ring and rounded corners, which a ring or radius class would replace.
const HIGHLIGHT_CLASSES = ["outline-2", "outline-primary", "outline-offset-2"];

/** Input from the user, who is then scrolling for themselves: the jump stops moving the view. */
const USER_INPUT_EVENTS = ["wheel", "touchmove", "pointerdown", "keydown"] as const;

const WHITESPACE = /\s+/;

interface SettingsRowTarget {
    /** The input the row's label names, when it names one. */
    control: HTMLElement | null;
    row: HTMLElement;
}

/** The input a label names, through `for`/nesting or through an `aria-labelledby` pointing at its id. */
const controlOf = (root: HTMLElement, title: HTMLElement): HTMLElement | null => {
    if (title instanceof HTMLLabelElement && title.control) {
        return title.control;
    }

    if (!title.id) {
        return null;
    }

    for (const candidate of root.querySelectorAll<HTMLElement>("[aria-labelledby]")) {
        if (candidate.getAttribute("aria-labelledby")?.split(WHITESPACE).includes(title.id)) {
            return candidate;
        }
    }

    return null;
};

/** What gets scrolled to and outlined for a title: a card for a card title, else its field, else the smallest wrapper holding both the title and its control. */
const rowOf = (title: HTMLElement, control: HTMLElement | null): HTMLElement => {
    if (title.matches(CARD_TITLE_SELECTOR)) {
        return title.closest<HTMLElement>(CARD_SELECTOR) ?? title;
    }

    const field = title.closest<HTMLElement>(FIELD_SELECTOR);

    if (field) {
        return field;
    }

    let wrapper = title.parentElement;

    while (control && wrapper && !wrapper.contains(control)) {
        wrapper = wrapper.parentElement;
    }

    return wrapper ?? title.parentElement ?? title;
};

/** The first element under `root` whose text is `label`, ignoring case and accents. */
const locate = (root: HTMLElement, label: string): SettingsRowTarget | null => {
    const wanted = normalizeSearchText(label.trim());

    for (const candidate of root.querySelectorAll<HTMLElement>(ROW_TITLE_SELECTOR)) {
        if (normalizeSearchText((candidate.textContent ?? "").trim()) === wanted) {
            const control = controlOf(root, candidate);

            return { control, row: rowOf(candidate, control) };
        }
    }

    return null;
};

export const findSettingsRow = (root: HTMLElement, label: string): HTMLElement | null => locate(root, label)?.row ?? null;

/**
 * Scrolls the row titled `label` into view once the tab has rendered it (tabs are lazy-loaded, so it may not exist yet)
 * and outlines it for two seconds. A row that never appears is not an error: the tab stays open at the top.
 * After the row first appears the jump keeps watching briefly and scrolls again if content above it moved the row,
 * and it stops at once when the user scrolls or types in the tab. `onReveal` runs once, with the row's control if it has one.
 * Returns a function that cancels the wait and removes the outline.
 */
export const jumpToSettingsRow = (root: HTMLElement, label: string, onReveal?: (control: HTMLElement | null) => void): (() => void) => {
    let highlighted: { added: string[]; row: HTMLElement } | null = null;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;
    let rowTop = 0;

    const clear = (): void => {
        highlighted?.row.classList.remove(...highlighted.added);
        highlighted = null;
    };

    const highlight = (row: HTMLElement): void => {
        clear();
        // Only what the row did not already have is added, so only that is taken off again.
        const added = HIGHLIGHT_CLASSES.filter((name) => !row.classList.contains(name));

        row.classList.add(...added);
        highlighted = { added, row };
    };

    const scrollTo = (row: HTMLElement): void => {
        row.scrollIntoView({ block: row.matches(CARD_SELECTOR) ? "start" : "center" });
        rowTop = row.getBoundingClientRect().top;
    };

    let observer: MutationObserver | undefined;

    const stopWatching = (): void => {
        observer?.disconnect();
        clearTimeout(giveUpTimer);
        clearTimeout(settleTimer);

        for (const event of USER_INPUT_EVENTS) {
            root.removeEventListener(event, stopWatching);
        }
    };

    const reveal = (): void => {
        const target = locate(root, label);

        if (!target) {
            return;
        }

        const { control, row } = target;

        if (revealed) {
            if (highlighted && row !== highlighted.row) {
                highlight(row);
            }

            if (Math.abs(row.getBoundingClientRect().top - rowTop) > 1) {
                scrollTo(row);
            }

            return;
        }

        revealed = true;
        clearTimeout(giveUpTimer);
        settleTimer = setTimeout(stopWatching, SETTLE_MS);
        scrollTo(row);
        highlight(row);
        highlightTimer = setTimeout(clear, HIGHLIGHT_DURATION_MS);
        onReveal?.(control);
    };

    observer = new MutationObserver(reveal);
    observer.observe(root, { childList: true, subtree: true });

    for (const event of USER_INPUT_EVENTS) {
        root.addEventListener(event, stopWatching, { passive: true });
    }

    giveUpTimer = setTimeout(stopWatching, WAIT_FOR_ROW_MS);
    reveal();

    return () => {
        stopWatching();
        clearTimeout(highlightTimer);
        clear();
    };
};
