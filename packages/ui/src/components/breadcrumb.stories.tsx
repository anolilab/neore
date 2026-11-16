import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./breadcrumb";

const meta = {
    component: Breadcrumb,
    title: "UI/Breadcrumb",
} satisfies Meta<typeof Breadcrumb>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("navigation", { name: "breadcrumb" })).toBeVisible();
        await expect(canvas.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#settings");
    },
    render: (args) => (
        <Breadcrumb {...args}>
            <BreadcrumbList>
                <BreadcrumbItem>
                    <BreadcrumbLink href="#home">Home</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                    <BreadcrumbLink href="#settings">Settings</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                    <BreadcrumbPage>Billing</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    ),
};

export const Collapsed: Story = {
    render: (args) => (
        <Breadcrumb {...args}>
            <BreadcrumbList>
                <BreadcrumbItem>
                    <BreadcrumbLink href="#home">Home</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                    <BreadcrumbEllipsis />
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                    <BreadcrumbLink href="#projects">Projects</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                    <BreadcrumbPage>Roadmap</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    ),
};

export const CustomSeparator: Story = {
    render: (args) => (
        <Breadcrumb {...args}>
            <BreadcrumbList>
                <BreadcrumbItem>
                    <BreadcrumbLink href="#home">Home</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem>
                    <BreadcrumbPage>Docs</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    ),
};
