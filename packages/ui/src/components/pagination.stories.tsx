import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "./pagination";

const meta = {
    component: Pagination,
    render: (args) => (
        <Pagination {...args}>
            <PaginationContent>
                <PaginationItem>
                    <PaginationPrevious href="#previous" />
                </PaginationItem>
                <PaginationItem>
                    <PaginationLink href="#1">1</PaginationLink>
                </PaginationItem>
                <PaginationItem>
                    <PaginationLink href="#2" isActive>
                        2
                    </PaginationLink>
                </PaginationItem>
                <PaginationItem>
                    <PaginationLink href="#3">3</PaginationLink>
                </PaginationItem>
                <PaginationItem>
                    <PaginationEllipsis />
                </PaginationItem>
                <PaginationItem>
                    <PaginationNext href="#next" />
                </PaginationItem>
            </PaginationContent>
        </Pagination>
    ),
    title: "UI/Pagination",
} satisfies Meta<typeof Pagination>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page");
        await expect(canvas.getByRole("button", { name: "Go to next page" })).toBeVisible();
    },
};

export const FirstPage: Story = {
    render: (args) => (
        <Pagination {...args}>
            <PaginationContent>
                <PaginationItem>
                    <PaginationLink href="#1" isActive>
                        1
                    </PaginationLink>
                </PaginationItem>
                <PaginationItem>
                    <PaginationLink href="#2">2</PaginationLink>
                </PaginationItem>
                <PaginationItem>
                    <PaginationNext href="#next" />
                </PaginationItem>
            </PaginationContent>
        </Pagination>
    ),
};
