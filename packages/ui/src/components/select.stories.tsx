import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "./select";

const models = [
    { label: "Fast", value: "fast" },
    { label: "Balanced", value: "balanced" },
    { label: "Thorough", value: "thorough" },
];

const meta = {
    args: { defaultValue: "balanced", items: models, onValueChange: fn() },
    component: Select,
    render: (args) => (
        <Select {...args}>
            <SelectTrigger aria-label="Model speed">
                <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                    {models.map((model) => (
                        <SelectItem key={model.value} value={model.value}>
                            {model.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    ),
    title: "UI/Select",
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("combobox", { name: "Model speed" })).toHaveTextContent("Balanced");
    },
};

export const Open: Story = {
    args: { defaultOpen: true },
    play: async ({ canvasElement }) => {
        const body = within(canvasElement.ownerDocument.body);

        await expect(await body.findByRole("option", { name: "Balanced" })).toBeVisible();
    },
};

export const ChooseOption: Story = {
    play: async ({ args, canvas, canvasElement }) => {
        await userEvent.click(canvas.getByRole("combobox", { name: "Model speed" }));
        const body = within(canvasElement.ownerDocument.body);

        await userEvent.click(await body.findByRole("option", { name: "Thorough" }));
        await expect(args.onValueChange).toHaveBeenCalledWith("thorough");
        await waitFor(() => expect(body.queryByRole("listbox")).toBeNull());
    },
};

export const Small: Story = {
    render: (args) => (
        <Select {...args}>
            <SelectTrigger aria-label="Model speed" size="sm">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="fast">Fast</SelectItem>
            </SelectContent>
        </Select>
    ),
};

export const Disabled: Story = {
    args: { defaultValue: "fast", disabled: true },
};

export const GroupedOpen: Story = {
    args: { defaultOpen: true, defaultValue: "fast" },
    render: (args) => (
        <Select {...args}>
            <SelectTrigger aria-label="Model">
                <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                    <SelectLabel>Quick</SelectLabel>
                    <SelectItem value="fast">Fast</SelectItem>
                </SelectGroup>
                <SelectSeparator />
                <SelectGroup>
                    <SelectLabel>Deep</SelectLabel>
                    <SelectItem value="thorough">Thorough</SelectItem>
                    <SelectItem disabled value="max">
                        Maximum
                    </SelectItem>
                </SelectGroup>
            </SelectContent>
        </Select>
    ),
};
