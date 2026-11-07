import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check } from "lucide-react";

import { Badge } from "./badge";

const VARIANTS = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;

const meta = {
    args: { children: "New" },
    argTypes: { variant: { control: "select", options: VARIANTS } },
    component: Badge,
    title: "UI/Badge",
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Secondary: Story = { args: { children: "Beta", variant: "secondary" } };

export const Outline: Story = { args: { children: "Free", variant: "outline" } };

export const Destructive: Story = {
    args: { children: "Failed", variant: "destructive" },
};

export const WithIcon: Story = {
    args: {
        children: (
            <>
                <Check aria-hidden="true" data-icon="inline-start" />
                Verified
            </>
        ),
        variant: "secondary",
    },
};

export const AsLink: Story = {
    args: {
        children: "Changelog",
        // Base UI renders `children` into this element.
        // eslint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label
        render: <a href="#changelog" />,
        variant: "outline",
    },
};

export const AllVariants: Story = {
    render: (args) => (
        <div className="flex flex-wrap gap-2">
            {VARIANTS.map((variant) => (
                <Badge {...args} key={variant} variant={variant}>
                    {variant}
                </Badge>
            ))}
        </div>
    ),
};
