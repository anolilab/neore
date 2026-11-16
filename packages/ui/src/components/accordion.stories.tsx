import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion";

const meta = {
    args: { onValueChange: fn() },
    component: Accordion,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Accordion {...args}>
            <AccordionItem value="models">
                <AccordionTrigger>Which models can I use?</AccordionTrigger>
                <AccordionContent>Every model in the picker is available on a paid plan; free accounts get a smaller set.</AccordionContent>
            </AccordionItem>
            <AccordionItem value="memory">
                <AccordionTrigger>Does it remember me?</AccordionTrigger>
                <AccordionContent>Memory is optional and can be switched off in settings.</AccordionContent>
            </AccordionItem>
            <AccordionItem disabled value="teams">
                <AccordionTrigger>Team workspaces</AccordionTrigger>
                <AccordionContent>Coming soon.</AccordionContent>
            </AccordionItem>
        </Accordion>
    ),
    title: "UI/Accordion",
} satisfies Meta<typeof Accordion>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        const trigger = canvas.getByRole("button", { name: "Which models can I use?" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(args.onValueChange).toHaveBeenCalled();
    },
};

export const OpenByDefault: Story = { args: { defaultValue: ["memory"] } };

export const Multiple: Story = { args: { defaultValue: ["models", "memory"], multiple: true } };

export const WithDisabledItem: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Team workspaces" })).toBeDisabled();
    },
};
