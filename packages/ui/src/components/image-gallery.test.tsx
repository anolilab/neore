// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GalleryItem } from "./image-gallery";
import { ImageGallery, ImageGalleryKreaGrid } from "./image-gallery";

const { saveFromUrl } = vi.hoisted(() => {
    return { saveFromUrl: vi.fn((_url: string, _filename?: string, _fallbackName?: string) => Promise.resolve()) };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; the download call is the thing under test
vi.mock("@ui/utils/save-from-url", () => {
    return { saveFromUrl };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ one, other, value }: { one: string; other: string; value: number }) => (value === 1 ? one : other),
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) =>
                    strings.reduce((out, part, index) => `${out}${part}${index < values.length ? String(values[index]) : ""}`, ""),
            };
        },
    };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const host = document.createElement("div");

document.body.append(host);

const root = createRoot(host);

const cat: GalleryItem = { alt: "cat.png", batchId: "batch-1", filename: "cat.png", id: "msg-1-0", src: "https://files.test/cat.png", type: "image" };
const dog: GalleryItem = { alt: "dog.png", batchId: "batch-1", filename: "dog.png", id: "msg-1-1", src: "https://files.test/dog.png", type: "image" };
/** An image with no file name and no description, as a batch can hold. */
const unnamed = (id: string): GalleryItem => {
    return { batchId: "batch-2", id, src: `https://files.test/${id}.png`, type: "image" };
};

/** An image whose classifier status is `status`. */
const withStatus = (status: string): GalleryItem => {
    return {
        alt: "status.png",
        batchId: "batch-3",
        filename: "status.png",
        id: `status-${status}`,
        nsfwStatus: status,
        src: "https://files.test/status.png",
        type: "image",
    };
};

const renderGallery = (items: GalleryItem[], onItemClick: (item: GalleryItem) => void): void => {
    act(() => {
        root.render(
            <ImageGallery items={items} onItemClick={onItemClick} selectedIds={[]} selectionEnabled={false}>
                <ImageGalleryKreaGrid />
            </ImageGallery>,
        );
    });
};

/** The save control whose accessible name is "Download <label>". */
const saveButton = (label: string): HTMLButtonElement | null =>
    [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === `Download ${label}`) ?? null;

afterEach(() => {
    act(() => root.render(<></>));
    saveFromUrl.mockClear();
});

describe("media gallery save control", () => {
    it("gives each generated image a named save control, numbered by its place in the gallery", () => {
        renderGallery([cat, dog], () => {});

        expect(saveButton("cat.png (1)")).not.toBeNull();
        expect(saveButton("dog.png (2)")).not.toBeNull();
    });

    it("names unnamed images apart, so a row of save controls tells them apart", () => {
        renderGallery([unnamed("a"), unnamed("b")], () => {});

        expect(saveButton("Gallery item (1)")).not.toBeNull();
        expect(saveButton("Gallery item (2)")).not.toBeNull();
    });

    it("saves the full file under its own name, and does not open the preview", () => {
        const onItemClick = vi.fn();

        renderGallery([cat], onItemClick);

        act(() => saveButton("cat.png (1)")?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/cat.png", "cat.png", "image-msg-1-0");
        expect(onItemClick).not.toHaveBeenCalled();
    });

    it("is a button of its own, outside the preview button, so keyboard focus reaches it", () => {
        renderGallery([cat], () => {});

        const save = saveButton("cat.png (1)");

        expect(save).not.toBeNull();
        expect(save?.parentElement?.closest("button")).toBeNull();

        act(() => save?.focus());

        expect(document.activeElement).toBe(save);
    });

    it("does not save a description as the file's name", () => {
        // A reference picker sets `alt` to a thread title and no file name: the file takes its fallback name.
        renderGallery([{ alt: "My chat", batchId: "batch-4", id: "ref-1", src: "https://files.test/ref-1.png", type: "image" }], () => {});

        act(() => saveButton("My chat (1)")?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/ref-1.png", undefined, "image-ref-1");
    });

    it("offers no save for an item marked not saveable, as a reference picker's are", () => {
        renderGallery([{ ...cat, id: "picker-1", saveable: false }], () => {});

        expect(saveButton("cat.png (1)")).toBeNull();
    });

    it("offers a save for an image the classifier cleared", () => {
        renderGallery([withStatus("safe")], () => {});

        expect(saveButton("status.png (1)")).not.toBeNull();
    });

    it.each(["pending", "checking", "failed", "blocked"])("withholds the save control for a %s image", (status) => {
        renderGallery([withStatus(status)], () => {});

        expect(saveButton("status.png (1)")).toBeNull();
    });
});
