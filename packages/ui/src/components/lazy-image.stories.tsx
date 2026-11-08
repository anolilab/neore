import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import LazyImage from "./lazy-image";

const svg = (label: string, color: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><text x="320" y="190" font-size="32" text-anchor="middle" fill="white">${label}</text></svg>`,
    )}`;

const meta = {
    args: { alt: "Sample landscape", ratio: 16 / 9, src: svg("Landscape", "#3b6ea5") },
    component: LazyImage,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/Lazy image",
} satisfies Meta<typeof LazyImage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "Sample landscape" })).toBeInTheDocument();
    },
};

export const Square: Story = { args: { ratio: 1 } };

export const LoadWhenInView: Story = { args: { inView: true } };

export const FallbackOnError: Story = {
    args: { alt: "Broken image", fallback: svg("Fallback", "#7a4a8c"), src: "data:image/svg+xml;utf8,not-an-image" },
    play: async ({ canvas }) => {
        const image = await canvas.findByRole("img", { name: "Broken image" });

        await waitFor(() => expect(image.getAttribute("src")).toContain("Fallback"));
    },
};
