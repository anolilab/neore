import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "./avatar";

const image = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#6d28d9"/><circle cx="32" cy="26" r="12" fill="#ddd6fe"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#ddd6fe"/></svg>',
)}`;

const meta = {
    argTypes: { size: { control: "inline-radio", options: ["sm", "default", "lg"] } },
    component: Avatar,
    title: "UI/Avatar",
} satisfies Meta<typeof Avatar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithImage: Story = {
    render: (args) => (
        <Avatar {...args}>
            <AvatarImage alt="Ada Lovelace" src={image} />
            <AvatarFallback>AL</AvatarFallback>
        </Avatar>
    ),
};

export const Initials: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("AL")).toBeVisible();
    },
    render: (args) => (
        <Avatar {...args}>
            <AvatarFallback>AL</AvatarFallback>
        </Avatar>
    ),
};

export const GeneratedFace: Story = {
    render: (args) => (
        <Avatar {...args}>
            <AvatarFallback name="Ada Lovelace" />
        </Avatar>
    ),
};

export const Sizes: Story = {
    render: () => (
        <div className="flex items-center gap-3">
            <Avatar size="sm">
                <AvatarFallback>S</AvatarFallback>
            </Avatar>
            <Avatar>
                <AvatarFallback>M</AvatarFallback>
            </Avatar>
            <Avatar size="lg">
                <AvatarFallback>L</AvatarFallback>
            </Avatar>
        </div>
    ),
};

export const WithBadge: Story = {
    render: (args) => (
        <Avatar {...args}>
            <AvatarFallback>AL</AvatarFallback>
            <AvatarBadge />
        </Avatar>
    ),
};

export const Group: Story = {
    render: () => (
        <AvatarGroup>
            <Avatar>
                <AvatarFallback>AL</AvatarFallback>
            </Avatar>
            <Avatar>
                <AvatarFallback>GH</AvatarFallback>
            </Avatar>
            <Avatar>
                <AvatarFallback>KJ</AvatarFallback>
            </Avatar>
            <AvatarGroupCount>+3</AvatarGroupCount>
        </AvatarGroup>
    ),
};
