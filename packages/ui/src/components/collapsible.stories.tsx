import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Button } from "./button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

const meta = {
    args: { onOpenChange: fn() },
    component: Collapsible,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Collapsible {...args}>
            <CollapsibleTrigger render={<Button variant="outline">Show details</Button>} />
            <CollapsibleContent>
                <p className="pt-2 text-sm">Extra details appear here once the section is expanded.</p>
            </CollapsibleContent>
        </Collapsible>
    ),
    title: "UI/Collapsible",
} satisfies Meta<typeof Collapsible>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ args, canvas }) => {
        const trigger = canvas.getByRole("button", { name: "Show details" });

        await userEvent.click(trigger);
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
    },
};

export const Open: Story = { args: { defaultOpen: true } };

export const Disabled: Story = { args: { disabled: true } };
