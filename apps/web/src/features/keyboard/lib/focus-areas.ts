/**
 * F6 moves focus between the screen's areas: the thread sidebar, the thread, the composer, the canvas and the
 * right panel. An area is any element marked `data-focus-area`, and they are visited in the order they appear.
 * An area's focus target is its first `data-focus-target` (or composer input) inside it, else the area itself.
 */
export const FOCUS_AREA_SELECTOR = "[data-focus-area]";

const FOCUSABLE = 'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]';

/** The index of the innermost area that holds the focus, or -1. Nested areas come after their container. */
export const focusAreaIndexOf = (areas: ReadonlyArray<Element>, active: Element | null): number => {
    let found = -1;

    areas.forEach((area, index) => {
        if (active !== null && area.contains(active)) {
            found = index;
        }
    });

    return found;
};

/** The next area in a direction, wrapping at both ends. From no area, forward starts at the first and back at the last. */
export const nextFocusAreaIndex = (count: number, current: number, direction: 1 | -1): number => {
    if (count === 0) {
        return -1;
    }

    if (current < 0) {
        return direction === 1 ? 0 : count - 1;
    }

    return (current + direction + count) % count;
};

const focusTargetOf = (area: HTMLElement): HTMLElement => area.querySelector<HTMLElement>("[data-focus-target], [data-composer-input]") ?? area;

/** Moves focus to an area's target. A target that cannot take focus gets `tabindex="-1"` so it still can. */
export const focusArea = (area: HTMLElement): void => {
    const target = focusTargetOf(area);

    if (!target.matches(FOCUSABLE)) {
        target.tabIndex = -1;
    }

    target.focus();
};

/**
 * An area the person can see: laid out, inside the viewport, and not part of a collapsed sidebar. A collapsed or
 * slid-away sidebar keeps its box, so a size check alone would let F6 land on it.
 */
const isShown = (area: HTMLElement): boolean => {
    if (area.closest('[data-state="collapsed"]') !== null || area.querySelector(':scope > [data-state="collapsed"]') !== null) {
        return false;
    }

    // A disabled composer keeps its place on the screen but cannot take focus.
    if (area.matches(":disabled") || area.getAttribute("aria-disabled") === "true" || area.getAttribute("contenteditable") === "false") {
        return false;
    }

    const { bottom, height, left, right, top, width } = area.getBoundingClientRect();

    return width > 0 && height > 0 && right > 0 && left < globalThis.innerWidth && bottom > 0 && top < globalThis.innerHeight;
};

/**
 * The topmost open modal dialog (a mobile sidebar sheet, a fullscreen canvas or presentation). Portals append to the body, so
 * the last one in the document is the one on top. While it is open, F6 stays inside it: a modal screen has no areas behind it.
 * A popover is not modal: it is a dialog for assistive tech, but the page stays reachable under it, so it never scopes F6.
 */
const topmostDialog = (): HTMLElement | null => {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-slot="popover-content"]), [role="alertdialog"]')].filter(
        (dialog) => dialog.getClientRects().length > 0,
    );

    return dialogs.at(-1) ?? null;
};

/** The areas F6 may visit right now: those of the topmost open dialog if there is one, else those of the page. */
const reachableAreas = (): HTMLElement[] => {
    const dialog = topmostDialog();
    const areas = [...(dialog ?? document).querySelectorAll<HTMLElement>(FOCUS_AREA_SELECTOR)];

    // A dialog can be an area itself (the mobile sidebar sheet): it comes first, as its own container.
    if (dialog?.matches(FOCUS_AREA_SELECTOR)) {
        areas.unshift(dialog);
    }

    return areas.filter((area) => isShown(area));
};

/** The last area that held the focus. A popup is portaled out of its area, so this is where F6 continues from. */
const focusMemory: { area: HTMLElement | null } = { area: null };

/** Records the area that receives focus (a `focusin` listener). A popup's own element belongs to no area and is skipped. */
export const trackFocusedArea = (event: FocusEvent): void => {
    if (event.target instanceof Element) {
        focusMemory.area = event.target.closest<HTMLElement>(FOCUS_AREA_SELECTOR) ?? focusMemory.area;
    }
};

/** Where F6 counts from: the area holding the focus, or, for a popup portaled out of one, the area it was opened from. */
const currentAreaIndex = (areas: ReadonlyArray<HTMLElement>): number => {
    const active = document.activeElement;
    const inArea = focusAreaIndexOf(areas, active);
    const inPopup = active?.closest('[role="menu"], [role="listbox"], [role="dialog"]') != null;

    return inArea === -1 && inPopup && focusMemory.area !== null ? areas.indexOf(focusMemory.area) : inArea;
};

/** The controls a dialog holds that the person can use: focusable, enabled and laid out. */
const dialogControls = (dialog: HTMLElement): HTMLElement[] =>
    [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (control) => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0,
    );

/**
 * A dialog with no area of its own (a fullscreen viewer, say) has no areas for F6 to visit, so F6 cycles its controls instead. A
 * dialog like that has no focus trap of its own, so this keeps the keyboard inside it. Returns false when it has no control to move
 * to, so the browser keeps the key.
 */
const focusNextDialogControl = (direction: 1 | -1): boolean => {
    const dialog = topmostDialog();

    if (!dialog) {
        return false;
    }

    const controls = dialogControls(dialog);
    const active = document.activeElement;
    const index = nextFocusAreaIndex(controls.length, controls.indexOf(active as HTMLElement), direction);
    const next = controls[index];

    if (!next || next === active) {
        return false;
    }

    next.focus();

    return true;
};

/**
 * Moves focus to the next (or previous) shown area. Returns false when focus would not move: the screen has no area, or
 * the area F6 would go to already holds the focus (the only one). The caller keeps the key for the browser then.
 */
export const focusNextArea = (direction: 1 | -1): boolean => {
    const areas = reachableAreas();

    if (areas.length === 0) {
        return focusNextDialogControl(direction);
    }

    const index = nextFocusAreaIndex(areas.length, currentAreaIndex(areas), direction);
    const next = areas[index];

    if (!next || index === focusAreaIndexOf(areas, document.activeElement)) {
        return false;
    }

    focusArea(next);

    return true;
};
