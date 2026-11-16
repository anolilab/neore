import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const meta = {
    args: { defaultValue: "overview", onValueChange: fn() },
    component: Tabs,
    render: (args) => (
        <Tabs {...args}>
            <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
                <TabsTrigger value="billing">Billing</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">A summary of your workspace.</TabsContent>
            <TabsContent value="usage">Tokens used this month.</TabsContent>
            <TabsContent value="billing">Invoices and payment methods.</TabsContent>
        </Tabs>
    ),
    title: "UI/Tabs",
} satisfies Meta<typeof Tabs>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("tab", { name: "Usage" }));
        await expect(args.onValueChange).toHaveBeenCalledWith("usage");
        await expect(canvas.getByRole("tab", { name: "Usage" })).toHaveAttribute("aria-selected", "true");
        await expect(canvas.getByText("Tokens used this month.")).toBeVisible();
    },
};

export const KeyboardNavigation: Story = {
    play: async ({ canvas }) => {
        canvas.getByRole("tab", { name: "Overview" }).focus();
        // The next tab is on the right in left-to-right text and on the left in right-to-left.
        await userEvent.keyboard(document.documentElement.dir === "rtl" ? "{ArrowLeft}" : "{ArrowRight}");
        await expect(canvas.getByRole("tab", { name: "Usage" })).toHaveFocus();
    },
};

export const Line: Story = {
    render: (args) => (
        <Tabs {...args}>
            <TabsList variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
                <TabsTrigger value="billing">Billing</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">A summary of your workspace.</TabsContent>
            <TabsContent value="usage">Tokens used this month.</TabsContent>
            <TabsContent value="billing">Invoices and payment methods.</TabsContent>
        </Tabs>
    ),
};

export const Vertical: Story = {
    args: { orientation: "vertical" },
};

export const DisabledTab: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("tab", { name: "Billing" })).toHaveAttribute("aria-disabled", "true");
    },
    render: (args) => (
        <Tabs {...args}>
            <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
                <TabsTrigger disabled value="billing">
                    Billing
                </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">A summary of your workspace.</TabsContent>
            <TabsContent value="usage">Tokens used this month.</TabsContent>
            <TabsContent value="billing">Invoices and payment methods.</TabsContent>
        </Tabs>
    ),
};
