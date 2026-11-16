import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { ImageComparison, ImageComparisonImage, ImageComparisonSlider } from "./image-comparison";

const panel = (label: string, color: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${color}"/><text x="320" y="210" font-size="40" text-anchor="middle" fill="white">${label}</text></svg>`,
    )}`;

const meta = {
    args: { children: null },
    component: ImageComparison,
    decorators: [
        (Story) => (
            <div className="w-full max-w-xl">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <ImageComparison {...args} className="aspect-video w-full rounded-lg border">
            <ImageComparisonImage alt="Before edit" position="left" src={panel("Before", "#8a4b2f")} />
            <ImageComparisonImage alt="After edit" position="right" src={panel("After", "#2f5d9b")} />
            <ImageComparisonSlider className="bg-white">
                <span className="sr-only">Drag to compare</span>
            </ImageComparisonSlider>
        </ImageComparison>
    ),
    title: "UI/Image comparison",
} satisfies Meta<typeof ImageComparison>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("slider")).toHaveAttribute("aria-valuenow", "50");
    },
};

export const KeyboardStep: Story = {
    play: async ({ canvas }) => {
        const slider = canvas.getByRole("slider");

        slider.focus();
        await userEvent.keyboard("{ArrowRight}");
        await expect(slider).toHaveAttribute("aria-valuenow", "55");
        await userEvent.keyboard("{End}");
        await expect(slider).toHaveAttribute("aria-valuenow", "100");
        await userEvent.keyboard("{Home}");
        await expect(slider).toHaveAttribute("aria-valuenow", "0");
    },
};

export const FollowsPointer: Story = {
    args: { enableHover: true },
};
