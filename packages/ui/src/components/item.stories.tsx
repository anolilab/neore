import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileTextIcon } from "lucide-react";

import { Button } from "./button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemHeader, ItemMedia, ItemTitle } from "./item";

const meta = {
    argTypes: {
        size: { control: "inline-radio", options: ["default", "sm", "xs"] },
        variant: { control: "inline-radio", options: ["default", "muted", "outline"] },
    },
    component: Item,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Item {...args}>
            <ItemMedia variant="icon">
                <FileTextIcon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
                <ItemTitle>Quarterly report</ItemTitle>
                <ItemDescription>Edited 2 hours ago</ItemDescription>
            </ItemContent>
            <ItemActions>
                <Button size="sm" variant="outline">
                    Open
                </Button>
            </ItemActions>
        </Item>
    ),
    title: "UI/Item",
} satisfies Meta<typeof Item>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Outline: Story = { args: { variant: "outline" } };

export const Muted: Story = { args: { variant: "muted" } };

export const Small: Story = { args: { size: "sm", variant: "outline" } };

export const ExtraSmall: Story = { args: { size: "xs", variant: "outline" } };

export const HeaderAndFooter: Story = {
    args: { variant: "outline" },
    render: (args) => (
        <Item {...args}>
            <ItemHeader>
                <ItemTitle>Weekly digest</ItemTitle>
                <span className="text-muted-foreground text-xs">Mon</span>
            </ItemHeader>
            <ItemContent>
                <ItemDescription>A summary of what changed in your workspace.</ItemDescription>
            </ItemContent>
            <ItemFooter>
                <span className="text-muted-foreground text-xs">3 unread</span>
            </ItemFooter>
        </Item>
    ),
};

export const Group: Story = {
    render: () => (
        <ItemGroup>
            <Item>
                <ItemContent>
                    <ItemTitle>Profile</ItemTitle>
                    <ItemDescription>Name and avatar</ItemDescription>
                </ItemContent>
            </Item>
            <Item>
                <ItemContent>
                    <ItemTitle>Security</ItemTitle>
                    <ItemDescription>Password and sessions</ItemDescription>
                </ItemContent>
            </Item>
        </ItemGroup>
    ),
};
