import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import PresentationArtifact from "./presentation-artifact";

const meta = {
    args: { onOpen: fn(), presentationId: "pres-1", slideCount: 12, title: "Quarterly business review" },
    component: PresentationArtifact,
    decorators: [
        (Story) => (
            <div className="max-w-sm">
                <Story />
            </div>
        ),
    ],
    title: "Chat/PresentationArtifact",
} satisfies Meta<typeof PresentationArtifact>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("Presentation · 12 slides")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: /Quarterly business review/u }));
        await expect(args.onOpen).toHaveBeenCalledWith("pres-1", 1);
    },
};

export const WithStyle: Story = {
    args: { styleName: "editorial" },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Presentation · 12 slides · editorial")).toBeVisible();
    },
};

/** The default style is not named on the card. */
export const DefaultStyle: Story = { args: { styleName: "default" } };

export const SingleSlide: Story = {
    args: { slideCount: 1 },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Presentation · 1 slide")).toBeVisible();
    },
};

export const NoSlidesYet: Story = {
    args: { slideCount: 0 },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Presentation")).toBeVisible();
    },
};

export const LongTitle: Story = { args: { title: "A presentation whose title is long enough that it has to be truncated on the card" } };
