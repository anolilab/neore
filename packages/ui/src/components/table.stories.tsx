import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "./table";

const rows = [
    { amount: "$12.00", id: "INV-001", status: "Paid" },
    { amount: "$48.50", id: "INV-002", status: "Pending" },
    { amount: "$7.25", id: "INV-003", status: "Paid" },
];

const meta = {
    component: Table,
    render: (args) => (
        <Table {...args}>
            <TableCaption>Recent invoices</TableCaption>
            <TableHeader>
                <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => (
                    <TableRow key={row.id}>
                        <TableCell>{row.id}</TableCell>
                        <TableCell>{row.status}</TableCell>
                        <TableCell className="text-right">{row.amount}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    ),
    title: "UI/Table",
} satisfies Meta<typeof Table>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getAllByRole("row")).toHaveLength(4);
    },
};

export const WithFooter: Story = {
    render: (args) => (
        <Table {...args}>
            <TableHeader>
                <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => (
                    <TableRow key={row.id}>
                        <TableCell>{row.id}</TableCell>
                        <TableCell className="text-right">{row.amount}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
            <TableFooter>
                <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right">$67.75</TableCell>
                </TableRow>
            </TableFooter>
        </Table>
    ),
};

export const SelectedRow: Story = {
    render: (args) => (
        <Table {...args}>
            <TableHeader>
                <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                <TableRow data-state="selected">
                    <TableCell>INV-001</TableCell>
                    <TableCell>Paid</TableCell>
                </TableRow>
                <TableRow>
                    <TableCell>INV-002</TableCell>
                    <TableCell>Pending</TableCell>
                </TableRow>
            </TableBody>
        </Table>
    ),
};

export const Empty: Story = {
    render: (args) => (
        <Table {...args}>
            <TableHeader>
                <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                <TableRow>
                    <TableCell className="text-muted-foreground h-16 text-center" colSpan={2}>
                        No invoices yet.
                    </TableCell>
                </TableRow>
            </TableBody>
        </Table>
    ),
};
