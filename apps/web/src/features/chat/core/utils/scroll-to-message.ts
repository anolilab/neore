const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Scrolls a reply on screen to the middle of the view. Answers false when that reply is not rendered: it is windowed
 * out of the list, or it belongs to another thread. The scroll is instant for users who ask for reduced motion.
 */
export const scrollToMessage = (messageId: string): boolean => {
    const element = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((candidate) => candidate.dataset.messageId === messageId);

    if (!element) {
        return false;
    }

    const behavior: ScrollBehavior = globalThis.matchMedia(REDUCED_MOTION_QUERY).matches ? "instant" : "smooth";

    element.scrollIntoView({ behavior, block: "center" });

    return true;
};
