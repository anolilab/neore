import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";

const meta: Meta<typeof HoverCard> = {
    args: { defaultOpen: true },
    component: HoverCard,
    decorators: [
        (Story) => (
            <div className="flex min-h-48 items-start justify-center pt-4">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <HoverCard {...args}>
            <HoverCardTrigger href="#profile">@ada</HoverCardTrigger>
            <HoverCardContent>
                <p className="text-sm font-medium">Ada Lovelace</p>
                <p className="text-muted-foreground text-xs">Wrote the first program. Member since 2024.</p>
            </HoverCardContent>
        </HoverCard>
    ),
    title: "UI/Hover card",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Closed: Story = { args: { defaultOpen: false } };

export const OnHover: Story = {
    args: { defaultOpen: false },
    play: async ({ canvas }) => {
        await userEvent.hover(canvas.getByRole("link", { name: "@ada" }));
        await expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    },
};
