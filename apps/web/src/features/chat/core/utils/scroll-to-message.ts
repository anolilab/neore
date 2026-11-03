/**
 * Scrolls a reply on screen to the middle of the view. Answers false when that reply is not rendered: it is windowed
 * out of the list, or it belongs to another thread.
 */
export const scrollToMessage = (messageId: string): boolean => {
    const element = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((candidate) => candidate.dataset.messageId === messageId);

    if (!element) {
        return false;
    }

    element.scrollIntoView({ behavior: "smooth", block: "center" });

    return true;
};
