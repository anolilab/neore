/** How far above the end the list may be and still count as at the latest message, in points. */
const END_TOLERANCE = 24;

/** Whether the list shows its last message: the viewport reaches the end of the content, within the tolerance. */
export const isScrolledToEnd = ({ contentHeight, layoutHeight, offsetY }: { contentHeight: number; layoutHeight: number; offsetY: number }): boolean =>
    offsetY + layoutHeight >= contentHeight - END_TOLERANCE;

/** The button shows while a reply streams, so the state of the reply is always on screen, and whenever the list is not at its end. */
export const shouldShowScrollToLatest = ({ isScrolledToEnd: isAtEnd, isStreaming }: { isScrolledToEnd: boolean; isStreaming: boolean }): boolean =>
    isStreaming || !isAtEnd;

/** The visible text of the button: "Working" while a reply streams, otherwise where the button leads. */
export const scrollToLatestText = (isStreaming: boolean): string => {
    if (isStreaming) {
        return "Working…";
    }

    return "Jump to latest";
};

/** The button's accessible name, which says both the state and what the tap does. */
export const scrollToLatestLabel = (isStreaming: boolean): string => {
    if (isStreaming) {
        return "Working. Jump to the latest message";
    }

    return "Jump to the latest message";
};
