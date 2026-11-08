import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Heading, HeadingLevelProvider, HeadingSection } from "./heading";

const meta = {
    component: Heading,
    title: "UI/Heading",
} satisfies Meta<typeof Heading>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OutsideAnOutline: Story = {
    args: { children: "Settings" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
    },
};

export const FallbackLevel: Story = {
    args: { children: "Settings", fallbackLevel: 3 },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("heading", { level: 3, name: "Settings" })).toBeVisible();
    },
};

export const NestedOutline: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
        await expect(canvas.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
        await expect(canvas.getByRole("heading", { level: 3, name: "Avatar" })).toBeVisible();
    },
    render: () => (
        <HeadingLevelProvider level={1}>
            <Heading className="text-lg font-semibold">Account</Heading>
            <HeadingSection>
                <Heading className="text-base font-medium">Profile</Heading>
                <HeadingSection>
                    <Heading className="text-sm font-medium">Avatar</Heading>
                </HeadingSection>
            </HeadingSection>
        </HeadingLevelProvider>
    ),
};
