import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { InlineEdit } from "./inline-edit";
import { Input } from "./input";

const meta: Meta<typeof InlineEdit> = {
    args: {
        defaultValue: "Planning the launch",
        onCancel: fn(),
        onSave: fn(),
        renderInput: (props) => <Input aria-label="Chat title" {...props} />,
    },
    component: InlineEdit,
    decorators: [
        (Story) => (
            <div className="w-72">
                <Story />
            </div>
        ),
    ],
    title: "UI/Inline edit",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Planning the launch" })).toBeVisible();
    },
};

export const Empty: Story = {
    args: { defaultValue: "" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Click to edit..." })).toBeVisible();
    },
};

export const Editing: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Planning the launch" }));
        await expect(await canvas.findByRole("textbox")).toHaveFocus();
    },
};

export const SaveWithEnter: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Planning the launch" }));

        const input = await canvas.findByRole("textbox");

        await userEvent.clear(input);
        await userEvent.type(input, "Renamed{Enter}");
        await expect(args.onSave).toHaveBeenCalledWith("Renamed");
        await expect(canvas.getByRole("button", { name: "Renamed" })).toBeVisible();
    },
};

export const CancelWithEscape: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Planning the launch" }));
        await userEvent.type(await canvas.findByRole("textbox"), " draft{Escape}");
        await expect(args.onCancel).toHaveBeenCalled();
        await expect(canvas.getByRole("button", { name: "Planning the launch" })).toBeVisible();
    },
};

export const WithoutControls: Story = {
    args: { showControls: false },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Planning the launch" }));
        await canvas.findByRole("textbox");
        await expect(canvas.queryByRole("button", { name: "Save" })).toBeNull();
    },
};

export const Disabled: Story = {
    args: { disabled: true },
};
