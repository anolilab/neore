import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { GalleryItem } from "./image-gallery";
import { ImageGallery, ImageGalleryEmpty, ImageGalleryGrid } from "./image-gallery";

const swatch = (label: string, color: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="${color}"/><text x="160" y="170" font-size="28" text-anchor="middle" fill="white">${label}</text></svg>`,
    )}`;

const items: GalleryItem[] = [
    { alt: "Blue swatch", id: "1", src: swatch("Blue", "#2f5d9b"), type: "image" },
    { alt: "Green swatch", id: "2", src: swatch("Green", "#2f7d4f"), type: "image" },
    { alt: "Purple swatch", id: "3", src: swatch("Purple", "#6b3f9a"), type: "image" },
    { alt: "Clip preview", duration: 83, id: "4", src: swatch("Clip", "#8a4b2f"), type: "video" },
];

const meta: Meta<typeof ImageGallery> = {
    args: { items, onItemClick: fn(), onSelectionChange: undefined },
    component: ImageGallery,
    decorators: [
        (Story) => (
            <div className="max-w-xl p-2">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <ImageGallery {...args}>
            <ImageGalleryGrid />
        </ImageGallery>
    ),
    title: "UI/Image gallery",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Green swatch" }));
        await expect(args.onItemClick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    },
};

export const SelectItems: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getAllByRole("checkbox", { name: "Select image as reference" }).at(0) as HTMLElement);
        await expect(canvas.getByRole("checkbox", { name: "Deselect image" })).toBeChecked();
    },
};

export const SelectionLimit: Story = {
    args: { maxSelections: 1, selectedIds: ["1"] },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("checkbox", { name: "Deselect image" })).toBeChecked();
    },
};

export const SelectionDisabled: Story = {
    args: { selectionEnabled: false },
    play: async ({ canvas }) => {
        await expect(canvas.queryAllByRole("checkbox")).toHaveLength(0);
    },
};

export const BlockedItem: Story = {
    args: { items: [{ id: "x", nsfwStatus: "blocked", src: swatch("Hidden", "#000000"), type: "image" }, ...items.slice(0, 2)] },
    play: async ({ canvas }) => {
        await expect(await canvas.findAllByRole("button", { name: /swatch/ })).toHaveLength(2);
        await expect(canvas.getByText("Flagged")).toBeVisible();
    },
};

export const Empty: Story = {
    args: { items: [] },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("No items")).toBeVisible();
    },
    render: (args) => (
        <ImageGallery {...args}>
            <ImageGalleryEmpty />
        </ImageGallery>
    ),
};
