import { describe, expect, it } from "vitest";

import { isScrolledToEnd, scrollToLatestLabel, scrollToLatestText, shouldShowScrollToLatest } from "./scroll-to-latest";

describe("isScrolledToEnd", () => {
    it("is at the end when the viewport reaches the content's end", () => {
        expect(isScrolledToEnd({ contentHeight: 1000, layoutHeight: 800, offsetY: 200 })).toBe(true);
    });

    it("is at the end within the tolerance above it", () => {
        expect(isScrolledToEnd({ contentHeight: 1000, layoutHeight: 800, offsetY: 176 })).toBe(true);
    });

    it("is not at the end when the list is scrolled up", () => {
        expect(isScrolledToEnd({ contentHeight: 1000, layoutHeight: 800, offsetY: 0 })).toBe(false);
    });

    it("is at the end when the content fits on screen", () => {
        expect(isScrolledToEnd({ contentHeight: 300, layoutHeight: 800, offsetY: 0 })).toBe(true);
    });
});

describe("shouldShowScrollToLatest", () => {
    it("shows while a reply streams, even at the end", () => {
        expect(shouldShowScrollToLatest({ isScrolledToEnd: true, isStreaming: true })).toBe(true);
    });

    it("shows when the list is scrolled up and no reply streams", () => {
        expect(shouldShowScrollToLatest({ isScrolledToEnd: false, isStreaming: false })).toBe(true);
    });

    it("hides at the end when no reply streams", () => {
        expect(shouldShowScrollToLatest({ isScrolledToEnd: true, isStreaming: false })).toBe(false);
    });
});

describe("scroll-to-latest text", () => {
    it("says working while a reply streams, and where the button leads otherwise", () => {
        expect(scrollToLatestText(true)).toBe("Working…");
        expect(scrollToLatestText(false)).toBe("Jump to latest");
    });

    it("names the state and the tap in the accessible label", () => {
        expect(scrollToLatestLabel(true)).toBe("Working. Jump to the latest message");
        expect(scrollToLatestLabel(false)).toBe("Jump to the latest message");
    });
});
