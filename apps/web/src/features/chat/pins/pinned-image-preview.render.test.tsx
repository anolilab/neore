// @vitest-environment jsdom

/** An image pin shows its image from the loaded messages, and a label while its message is not loaded. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => {
    return { messages: [] as { id: string; parts: unknown[] }[] };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: loaded.messages };
        },
    };
});

const { default: PinnedImagePreview, findPinnedImage } = await import("./pinned-image-preview");

const reply = {
    id: "m1",
    parts: [
        { text: "Here are two takes.", type: "text" },
        { filename: "fox.png", mediaType: "image/png", type: "file", url: "https://files.example/fox.png" },
        { image: "https://files.example/owl.png", type: "image" },
        { filename: "notes.pdf", mediaType: "application/pdf", type: "file", url: "https://files.example/notes.pdf" },
        { mediaType: "image/png", nsfwStatus: "blocked", type: "file", url: "https://files.example/x.png" },
    ],
};

describe(findPinnedImage, () => {
    it("finds a file image and an image part by message and part index", () => {
        expect(findPinnedImage([reply], "m1", 1)).toEqual({ filename: "fox.png", url: "https://files.example/fox.png" });
        expect(findPinnedImage([reply], "m1", 2)).toEqual({ filename: undefined, url: "https://files.example/owl.png" });
    });

    it("finds nothing for text, a non-image file, a blocked image, a missing part or an unloaded message", () => {
        expect(findPinnedImage([reply], "m1", 0)).toBeNull();
        expect(findPinnedImage([reply], "m1", 3)).toBeNull();
        expect(findPinnedImage([reply], "m1", 4)).toBeNull();
        expect(findPinnedImage([reply], "m1", 9)).toBeNull();
        expect(findPinnedImage([reply], "m2", 1)).toBeNull();
    });
});

describe("PinnedImagePreview", () => {
    it("shows the pinned image, named by the pin's caption", () => {
        loaded.messages = [reply];
        render(<PinnedImagePreview alt="A fox logo" messageId="m1" partIndex={1} />);

        expect(screen.getByRole("img", { name: "A fox logo" }).getAttribute("src")).toBe("https://files.example/fox.png");
    });

    it("says an image is pinned while its message is not loaded", () => {
        loaded.messages = [];
        render(<PinnedImagePreview messageId="m1" partIndex={1} />);

        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByText("Image pinned")).toBeTruthy();
    });
});
