import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyIcon, SearchIcon } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group";
import { Kbd } from "./kbd";

const onCopy = fn();

const meta = {
    component: InputGroup,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/InputGroup",
} satisfies Meta<typeof InputGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithLeadingIcon: Story = {
    render: (args) => (
        <InputGroup {...args}>
            <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput aria-label="Search" placeholder="Search chats" />
        </InputGroup>
    ),
};

export const WithButton: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
        await expect(onCopy).toHaveBeenCalled();
    },
    render: (args) => (
        <InputGroup {...args}>
            <InputGroupInput aria-label="Share link" readOnly value="https://example.com/s/abc123" />
            <InputGroupAddon align="inline-end">
                <InputGroupButton aria-label="Copy" onClick={onCopy} size="icon-xs">
                    <CopyIcon aria-hidden="true" />
                </InputGroupButton>
            </InputGroupAddon>
        </InputGroup>
    ),
};

export const WithShortcut: Story = {
    render: (args) => (
        <InputGroup {...args}>
            <InputGroupInput aria-label="Command" placeholder="Type a command" />
            <InputGroupAddon align="inline-end">
                <Kbd>/</Kbd>
            </InputGroupAddon>
        </InputGroup>
    ),
};

export const Invalid: Story = {
    render: (args) => (
        <InputGroup {...args}>
            <InputGroupInput aria-invalid="true" aria-label="Username" defaultValue="a" />
        </InputGroup>
    ),
};
