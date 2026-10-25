import type { RefObject } from "react";
import { useEffect, useEffectEvent } from "react";

const TABBABLE =
    'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';

const isTabbable = (element: HTMLElement): boolean => {
    if (element.tabIndex < 0 || element.closest("[hidden], [inert]")) {
        return false;
    }

    // Absent in jsdom; a real browser answers for display:none and visibility:hidden ancestors too.
    return typeof element.checkVisibility === "function" ? element.checkVisibility({ visibilityProperty: true }) : true;
};

const tabbablesIn = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => isTabbable(element));

/** Keeps a Tab press inside `container`: wraps at either end and pulls in focus that is not inside it. */
const wrapTab = (event: KeyboardEvent, container: HTMLElement): void => {
    const { shiftKey, target } = event;
    const inside = target instanceof Node && container.contains(target);
    const tabbables = tabbablesIn(container);
    const first = tabbables.at(0);
    const last = tabbables.at(-1);

    if (!first || !last) {
        event.preventDefault();
        container.focus({ preventScroll: true });
    } else if (!inside) {
        event.preventDefault();
        (shiftKey ? last : first).focus();
    } else if (shiftKey && (target === first || target === container)) {
        event.preventDefault();
        last.focus();
    } else if (!shiftKey && target === last) {
        event.preventDefault();
        first.focus();
    }
};

interface UseFocusTrapOptions {
    /** Whether the container is currently shown as a modal. */
    active: boolean;

    /**
     * Called on Escape pressed inside the container (and not already handled by something
     * inside it, such as a menu). Leave it out when the caller closes on Escape itself.
     */
    onEscape?: () => void;
}

/**
 * Modal focus management for a hand-rolled overlay that a dialog primitive does
 * not wrap (a full-screen viewer): focus moves onto the container when it
 * becomes active, Tab and Shift+Tab wrap inside it, and focus goes back to the
 * element that held it before when it stops being active or unmounts.
 *
 * The container needs `role="dialog"`, `aria-modal="true"` and a name; the hook
 * focuses the container itself, so it carries `tabIndex={-1}`. Focus inside a
 * portaled child (a dropdown, a nested dialog) is that child's to manage and is
 * left alone. Content outside the container is not made inert here.
 */
const useFocusTrap = (containerRef: RefObject<HTMLElement | null>, { active, onEscape }: UseFocusTrapOptions): void => {
    const escape = useEffectEvent(() => onEscape?.());

    useEffect(() => {
        const container = containerRef.current;

        if (!active || !container) {
            return undefined;
        }

        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        container.focus({ preventScroll: true });

        const handleKeyDown = (event: KeyboardEvent) => {
            const { target } = event;

            // A container removed while still active must not keep swallowing Tab for the page.
            if (!container.isConnected) {
                return;
            }

            if (event.key === "Escape") {
                if (!event.defaultPrevented && target instanceof Node && container.contains(target)) {
                    escape();
                }

                return;
            }

            if (event.key !== "Tab" || event.defaultPrevented) {
                return;
            }

            if (target instanceof Node && !container.contains(target) && target !== document.body && target !== document.documentElement) {
                // Focus that left for a portaled child manages itself; only focus dropped on the page body is pulled back in.
                return;
            }

            wrapTab(event, container);
        };

        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);

            if (opener?.isConnected && opener !== document.body) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [active, containerRef]);
};

export default useFocusTrap;
