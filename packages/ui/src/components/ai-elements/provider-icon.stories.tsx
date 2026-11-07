import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { IconSpriteSheet, ProviderIcon } from "./provider-icon";

const meta: Meta<typeof ProviderIcon> = {
    args: { provider: "Anthropic", providerIcon: "anthropic" },
    component: ProviderIcon,
    decorators: [
        (Story) => (
            <>
                <IconSpriteSheet />
                <Story />
            </>
        ),
    ],
    title: "Chat/ProviderIcon",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Large: Story = { args: { className: "size-12" } };

export const NoIcon: Story = {
    args: { providerIcon: null },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("AN")).toBeVisible();
    },
};

export const UnknownIcon: Story = { args: { provider: "Acme", providerIcon: "not-a-provider" } };

export const Several: Story = {
    render: () => (
        <div className="flex gap-3">
            {["anthropic", "openai", "google", "xai"].map((name) => (
                <ProviderIcon className="size-8" key={name} provider={name} providerIcon={name} />
            ))}
        </div>
    ),
};
