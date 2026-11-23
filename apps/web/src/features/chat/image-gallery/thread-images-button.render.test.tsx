// @vitest-environment jsdom

/** The header's Images button: shown for a chat with images whose message list shows, not in image or video mode's grid. */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("./use-thread-images", () => {
    return {
        default: () => [{ alt: "Chart", key: "tool:c1", kind: "code", messageId: "m1", src: "https://api.test/chart" }],
    };
});

vi.mock("./thread-image-gallery", () => {
    return { default: () => null };
});

const { useImageGalleryStore } = await import("./image-gallery-store");
const { default: ThreadImagesButton } = await import("./thread-images-button");

const BUTTON = { name: "Images in this chat (1)" };

describe("ThreadImagesButton", () => {
    beforeEach(() => {
        useImageGalleryStore.setState({ listShown: {} });
    });

    it("shows while the chat's message list shows", () => {
        useImageGalleryStore.getState().setListShown("t1", true);
        render(<ThreadImagesButton threadId="t1" />);

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });

    it("hides in image or video mode, where the chat shows its own grid and no message to go to", () => {
        useImageGalleryStore.getState().setListShown("t1", false);
        render(<ThreadImagesButton threadId="t1" />);

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it("goes by its own chat only", () => {
        useImageGalleryStore.getState().setListShown("t2", false);
        render(<ThreadImagesButton threadId="t1" />);

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });
});
