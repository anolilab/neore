// @vitest-environment jsdom

/** The chat's image gallery: opens at the chosen image, steps with the arrow keys and thumbnails, and jumps to the message. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollToMessage = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@neore/ui/components/zoomable-image", () => {
    return {
        // Focusable, as the real one's root is.
        ZoomableImage: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} tabIndex={-1} />,
    };
});

vi.mock("@/features/chat/core/utils/scroll-to-message", () => {
    return { scrollToMessage };
});

const { useImageGalleryStore } = await import("./image-gallery-store");
const { default: ThreadImageGallery, galleryIndexOf, galleryStep } = await import("./thread-image-gallery");

const IMAGES = [
    { alt: "Pricing page", key: "tool:call-1", kind: "browser" as const, messageId: "m1", src: "https://api.test/one" },
    { alt: "Chart", key: "tool:call-2:0", kind: "code" as const, messageId: "m2", src: "https://api.test/two" },
    { alt: "Logo", key: "m3:1", kind: "file" as const, messageId: "m3", src: "https://api.test/three" },
];

const PREVIEW_NAME = /^(Pricing page|Chart|Logo)$/u;

const preview = () => screen.getByRole("img", { name: PREVIEW_NAME });

const openAt = (key: string | null) => {
    act(() => {
        useImageGalleryStore.getState().openAt("t1", key);
    });
};

describe(galleryIndexOf, () => {
    it("finds the image by key, starts at the first for no key, and holds nothing for an unknown key", () => {
        expect(galleryIndexOf(IMAGES, "m3:1")).toBe(2);
        expect(galleryIndexOf(IMAGES, null)).toBe(0);
        expect(galleryIndexOf(IMAGES, "gone")).toBe(-1);
    });
});

describe(galleryStep, () => {
    it.each([
        ["ArrowRight", 0, 1],
        ["ArrowRight", 2, 2],
        ["ArrowLeft", 1, 0],
        ["ArrowLeft", 0, 0],
        ["Home", 2, 0],
        ["End", 0, 2],
        ["Enter", 1, null],
    ])("%s from %i goes to %s", (key, from, expected) => {
        expect(galleryStep(key, from, 3)).toBe(expected);
    });
});

describe("ThreadImageGallery", () => {
    beforeEach(() => {
        scrollToMessage.mockReset();
        useImageGalleryStore.setState({ opener: null, shown: null });
    });

    it("stays closed until an image is opened", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);

        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens at the chosen image", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt("tool:call-2:0");

        expect(preview().getAttribute("alt")).toBe("Chart");
        expect(screen.getByText("Image 2 of 3")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Image 2: Chart" }).getAttribute("aria-current")).toBe("true");
    });

    it("does not open at another image for a key it does not hold (a reply still streaming)", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt("tool:streaming-call");

        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("does not open for another chat's image", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        act(() => {
            useImageGalleryStore.getState().openAt("t2", "m3:1");
        });

        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("steps through the images with the arrow keys and stops at the ends", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt(null);

        const dialog = screen.getByRole("dialog");

        fireEvent.keyDown(dialog, { key: "ArrowRight" });
        expect(preview().getAttribute("alt")).toBe("Chart");

        fireEvent.keyDown(dialog, { key: "End" });
        expect(preview().getAttribute("alt")).toBe("Logo");

        fireEvent.keyDown(dialog, { key: "ArrowRight" });
        expect(preview().getAttribute("alt")).toBe("Logo");

        fireEvent.keyDown(dialog, { key: "Home" });
        expect(preview().getAttribute("alt")).toBe("Pricing page");
    });

    it("keeps the focus on the preview while the arrow keys replace it", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt(null);

        const first = preview();

        act(() => {
            first.focus();
        });
        fireEvent.keyDown(first, { key: "ArrowRight" });

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this test asserts
        expect(document.activeElement).toBe(screen.getByRole("img", { name: "Chart" }));
    });

    it("forgets its image when it goes away, so the chat's gallery does not open again on return", () => {
        const { unmount } = render(<ThreadImageGallery images={IMAGES} threadId="t1" />);

        openAt("m3:1");
        unmount();
        expect(useImageGalleryStore.getState().shown).toBeNull();

        act(() => {
            useImageGalleryStore.getState().openAt("t2", "x");
        });
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />).unmount();
        expect(useImageGalleryStore.getState().shown?.threadId).toBe("t2");
    });

    it("leaves a key a zoomed image already used alone", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt(null);

        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" });

        event.preventDefault();
        act(() => {
            screen.getByRole("dialog").dispatchEvent(event);
        });

        expect(preview().getAttribute("alt")).toBe("Pricing page");
    });

    it("shows the image whose thumbnail is chosen, and the buttons step too", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt(null);

        fireEvent.click(screen.getByRole("button", { name: "Image 3: Logo" }));
        expect(preview().getAttribute("alt")).toBe("Logo");
        expect((screen.getByRole("button", { name: "Next image" }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
        expect(preview().getAttribute("alt")).toBe("Chart");
    });

    it("closes and scrolls to the image's message", () => {
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt("m3:1");
        fireEvent.click(screen.getByRole("button", { name: "Go to message" }));

        expect(scrollToMessage).toHaveBeenCalledWith("m3", { threadId: "t1" });
        expect(useImageGalleryStore.getState().shown).toBeNull();
    });

    it("names an image with no name of its own by its kind", () => {
        const nameless = [
            { key: "tool:call-9", kind: "browser" as const, messageId: "m1", src: "https://api.test/a" },
            { key: "tool:call-8:0", kind: "code" as const, messageId: "m1", src: "https://api.test/b" },
        ];

        render(<ThreadImageGallery images={nameless} threadId="t1" />);
        openAt(null);

        expect(screen.getByRole("img", { name: "Browser screenshot" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Image 2: Code output" })).toBeTruthy();
    });

    it("hands the focus back to the control that opened it when it closes, even one a click did not focus", async () => {
        const opener = document.createElement("button");

        opener.textContent = "Images";
        document.body.appendChild(opener);
        // Safari does not focus a clicked button: the click hands the control over instead.
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        act(() => {
            useImageGalleryStore.getState().openAt("t1", null, opener);
        });

        expect(useImageGalleryStore.getState().opener).toBe(opener);

        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

        await waitFor(() => {
            // eslint-disable-next-line testing-library/no-node-access -- the assertion is about where the focus went
            expect(document.activeElement).toBe(opener);
        });
        opener.remove();
    });

    it("keeps the opener of an open gallery while it steps through the images", () => {
        const opener = document.createElement("button");

        document.body.appendChild(opener);
        opener.focus();
        render(<ThreadImageGallery images={IMAGES} threadId="t1" />);
        openAt(null);
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });

        expect(useImageGalleryStore.getState().opener).toBe(opener);
        opener.remove();
    });
});
