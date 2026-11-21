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

vi.mock("@/features/chat/core/context/chat-context-hooks", () => {
    return {
        useChatMessages: () => {
            return { messages: loaded.messages };
        },
    };
});

const { default: PinnedImagePreview, findPinnedImage, imageKeyOf } = await import("./pinned-image-preview");

const reply = {
    id: "m1",
    parts: [
        { text: "Here are two takes.", type: "text" },
        { filename: "fox.png", mediaType: "image/png", type: "file", url: "https://files.example/fox.png" },
        { image: "https://files.example/owl.png", type: "image" },
        { filename: "notes.pdf", mediaType: "application/pdf", type: "file", url: "https://files.example/notes.pdf" },
        { mediaType: "image/png", nsfwStatus: "blocked", type: "file", url: "https://files.example/x.png" },
        { data: "https://files.example/stored.png", filename: "stored.png", mediaType: "image/png", type: "file" },
    ],
};

describe(findPinnedImage, () => {
    it("finds a file image and an image part by message and image index", () => {
        expect(findPinnedImage([reply], "m1", 0)).toEqual({ filename: "fox.png", url: "https://files.example/fox.png" });
        expect(findPinnedImage([reply], "m1", 1)).toEqual({ filename: undefined, url: "https://files.example/owl.png" });
    });

    it("finds a stored file image whose link is in `data`", () => {
        expect(findPinnedImage([reply], "m1", 3)).toEqual({ filename: "stored.png", url: "https://files.example/stored.png" });
    });

    it("finds nothing for a blocked image, a missing image or an unloaded message", () => {
        expect(findPinnedImage([reply], "m1", 2)).toBeNull();
        expect(findPinnedImage([reply], "m1", 9)).toBeNull();
        expect(findPinnedImage([reply], "m2", 0)).toBeNull();
    });

    it("finds an image by its storage path wherever it sits, so an earlier image that went missing shifts nothing", () => {
        const pinned = "https://api.test/agent-files/b?sig=1";
        const before = {
            id: "m6",
            parts: [
                { image: "https://api.test/agent-files/a?sig=1", type: "image" },
                { image: pinned, type: "image" },
            ],
        };
        // The first image could not be signed again: it is a text part now, and the pinned one is image 0.
        const after = {
            id: "m6",
            parts: [
                { text: "[attachment unavailable]", type: "text" },
                { image: "https://api.test/agent-files/b?sig=2", type: "image" },
            ],
        };

        expect(findPinnedImage([before], "m6", 1, "/agent-files/b")?.url).toBe(pinned);
        expect(findPinnedImage([after], "m6", 1, "/agent-files/b")?.url).toBe("https://api.test/agent-files/b?sig=2");
        expect(findPinnedImage([after], "m6", 0, "/agent-files/a")).toBeNull();
    });

    it("keeps finding the pinned image after an edit removes the text before it", () => {
        const before = {
            id: "m5",
            parts: [
                { text: "First take:", type: "text" },
                { image: "https://files.example/a.png", type: "image" },
                { text: "done", type: "text" },
            ],
        };
        const edited = {
            id: "m5",
            parts: [
                { image: "https://files.example/a.png", type: "image" },
                { text: "Edited.", type: "text" },
            ],
        };

        expect(findPinnedImage([before], "m5", 0)?.url).toBe("https://files.example/a.png");
        expect(findPinnedImage([edited], "m5", 0)?.url).toBe("https://files.example/a.png");
    });
});

describe(imageKeyOf, () => {
    it("keeps a stored image's path, without host or signature, and nothing for an inline image", () => {
        expect(imageKeyOf("https://api.test/agent-files/abc?sig=1&exp=2")).toBe("/agent-files/abc");
        expect(imageKeyOf("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined();
        expect(imageKeyOf("not a url")).toBeUndefined();
    });
});

describe("PinnedImagePreview", () => {
    it("shows the pinned image, named by the pin's caption", () => {
        loaded.messages = [reply];
        render(<PinnedImagePreview alt="A fox logo" imageIndex={0} messageId="m1" />);

        expect(screen.getByRole("img", { name: "A fox logo" }).getAttribute("src")).toBe("https://files.example/fox.png");
    });

    it("says an image is pinned while its message is not loaded", () => {
        loaded.messages = [];
        render(<PinnedImagePreview imageIndex={0} messageId="m1" />);

        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByText("Image pinned")).toBeTruthy();
    });
});
