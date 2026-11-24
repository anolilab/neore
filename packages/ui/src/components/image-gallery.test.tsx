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

const cat: GalleryItem = { alt: "cat.png", batchId: "batch-1", id: "msg-1-0", src: "https://files.test/cat.png", type: "image" };
const dog: GalleryItem = { alt: "dog.png", batchId: "batch-1", id: "msg-1-1", src: "https://files.test/dog.png", type: "image" };
const flagged: GalleryItem = {
    alt: "flagged.png",
    batchId: "batch-1",
    id: "msg-1-2",
    nsfwStatus: "blocked",
    src: "https://files.test/flagged.png",
    type: "image",
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

const saveButton = (name: string): HTMLButtonElement | null =>
    [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === `Download ${name}`) ?? null;

afterEach(() => {
    act(() => root.render(<></>));
    saveFromUrl.mockClear();
});

describe("media gallery save control", () => {
    it("gives each generated image a named save control", () => {
        renderGallery([cat, dog], () => {});

        expect(saveButton("cat.png")).not.toBeNull();
        expect(saveButton("dog.png")).not.toBeNull();
    });

    it("does not offer to save an image the classifier flagged", () => {
        renderGallery([cat, flagged], () => {});

        expect(saveButton("cat.png")).not.toBeNull();
        expect(saveButton("flagged.png")).toBeNull();
    });

    it("saves the full file under its name, and does not open the preview", () => {
        const onItemClick = vi.fn();

        renderGallery([cat], onItemClick);

        act(() => saveButton("cat.png")?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/cat.png", "cat.png", "image-msg-1-0");
        expect(onItemClick).not.toHaveBeenCalled();
    });

    it("is a button of its own, outside the preview button, so keyboard focus reaches it", () => {
        renderGallery([cat], () => {});

        const save = saveButton("cat.png");

        expect(save).not.toBeNull();
        expect(save?.parentElement?.closest("button")).toBeNull();

        act(() => save?.focus());

        expect(document.activeElement).toBe(save);
    });
});
