/**
 * Univer's toolbar and sheet bar are third-party markup that axe reports for unnamed buttons and inputs,
 * a role that is not valid, a second banner, an unnamed region and a positive tabindex. This names and
 * repairs those elements where Univer renders them, and again whenever Univer re-renders them.
 *
 * Univer runs in en-US (see `createUniver` in univer-sheet-editor.tsx), so the names are English.
 */

const SHEET_ADD_LABEL = "Add sheet";
const OPTIONS_LABEL = "Options";
const VALUE_LABEL = "Value";
const TOOLBAR_LABEL = "Spreadsheet toolbar";

// Controls that a trigger must not contain: a button inside role="button" is nested-interactive.
const INTERACTIVE_DESCENDANT = 'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

// Each repair is idempotent: it only touches elements that still have the problem.
const repairControls = (root: HTMLElement): void => {
    // A trigger that opens a menu or dialog is a div or link with no role, so aria-haspopup and aria-expanded are not allowed on it.
    // One that holds a control is a container, not a button, so those attributes come off; the control keeps its own semantics.
    for (const trigger of root.querySelectorAll<HTMLElement>("[aria-haspopup]:not([role]):not(button)")) {
        if (trigger.querySelector(INTERACTIVE_DESCENDANT)) {
            trigger.removeAttribute("aria-haspopup");
            trigger.removeAttribute("aria-expanded");
        } else {
            trigger.setAttribute("role", "button");

            // A button must be a tab stop and respond to Enter and Space, which the keydown listener below provides.
            if (!trigger.hasAttribute("tabindex")) {
                trigger.setAttribute("tabindex", "0");
            }
        }
    }

    // An invalid role, used on a decorative bar.
    for (const track of root.querySelectorAll<HTMLElement>('[role="track"]')) {
        track.removeAttribute("role");
    }

    // Buttons, and the role="button" triggers above, with no visible text need a name for a screen reader.
    for (const control of root.querySelectorAll<HTMLElement>('button:not([aria-label]):not([title]), [role="button"]:not([aria-label]):not([title])')) {
        if (control.textContent?.trim()) {
            continue;
        }

        if (control.dataset.uComp === "sheet-bar-append-button") {
            control.setAttribute("aria-label", SHEET_ADD_LABEL);
        } else {
            control.setAttribute("aria-label", OPTIONS_LABEL);
        }
    }

    for (const input of root.querySelectorAll<HTMLInputElement>("input:not([aria-label]):not([id])")) {
        input.setAttribute("aria-label", VALUE_LABEL);
    }

    // A header is a banner landmark. Univer's header is a toolbar, so it is a named group instead, and the page keeps one banner.
    for (const header of root.querySelectorAll<HTMLElement>('header[data-u-comp="headerbar"]')) {
        header.setAttribute("role", "group");
        header.setAttribute("aria-label", TOOLBAR_LABEL);
    }

    // The notification region is an unnamed live region; naming it clashes with other landmarks.
    for (const region of root.querySelectorAll<HTMLElement>('section[aria-live="polite"][aria-label^="Notifications"]')) {
        region.removeAttribute("aria-label");
    }

    // Univer's render canvases use a positive tabindex to order focus. Keyboard focus follows the document order instead.
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')) {
        canvas.setAttribute("tabindex", "0");
    }
};

/**
 * Repairs `root` now, and again after each batch of changes inside it. Repairs are coalesced into one per frame, because
 * Univer re-renders its toolbar as the selection moves. Returns the function that stops watching.
 */
export const observeUniverAccessibility = (root: HTMLElement): (() => void) => {
    repairControls(root);

    let frame: number | null = null;

    const observer = new MutationObserver(() => {
        if (frame !== null) {
            return;
        }

        frame = requestAnimationFrame(() => {
            frame = null;
            repairControls(root);
        });
    });

    // The repaired triggers are buttons in the accessibility tree, so Enter and Space activate them as a native button would.
    const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target instanceof HTMLElement ? event.target : null;

        if ((event.key !== "Enter" && event.key !== " ") || !target || target.tagName === "BUTTON" || target.getAttribute("role") !== "button") {
            return;
        }

        event.preventDefault();
        target.click();
    };

    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("keydown", onKeyDown);

    return () => {
        observer.disconnect();
        root.removeEventListener("keydown", onKeyDown);

        if (frame !== null) {
            cancelAnimationFrame(frame);
        }
    };
};
