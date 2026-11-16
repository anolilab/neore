import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRightIcon, ChevronRightIcon, ReceiptIcon, XIcon } from "lucide-react";
import { expect } from "storybook/test";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardDescription, CardTitle } from "./card";

/** Static display states of the notification cards. Markup only; nothing here is wired to data. */
const InvoiceCard = () => (
    <Card className="relative w-full max-w-sm gap-0 overflow-hidden py-0">
        <div className="flex items-center gap-3 p-4 pe-10">
            <div className="border-border flex w-12 shrink-0 flex-col items-center rounded-md border py-1 leading-none">
                <span className="text-muted-foreground text-[0.625rem] font-medium uppercase">Nov</span>
                <span className="text-lg font-semibold">15</span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
                <CardTitle className="text-sm">Invoice INV-0412 from Acme Inc.</CardTitle>
                <CardDescription>€1,240 • in 3 days</CardDescription>
            </div>
        </div>
        <Button className="border-border w-full rounded-none border-t" variant="ghost">
            <ReceiptIcon aria-hidden="true" />
            Pay invoice
        </Button>
        <Button aria-label="Close" className="absolute end-2 top-2" size="icon" variant="ghost">
            <XIcon aria-hidden="true" />
        </Button>
    </Card>
);

const StorageCard = () => (
    <Card className="border-destructive/40 relative w-full max-w-md gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-2 p-4 pe-10">
            <CardTitle className="text-sm">Your workspace has used 95% of its available storage</CardTitle>
            <CardDescription className="text-xs">
                Uploads, syncing and backups will stop once storage is full. Free up space or upgrade your plan.
            </CardDescription>
            <div className="flex flex-wrap gap-2">
                <Badge className="bg-warning/10 text-warning-foreground">Storage limit warning</Badge>
                <Badge variant="outline">47.5 / 50 GB</Badge>
            </div>
        </div>
        <div className="border-destructive/20 bg-destructive/10 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-sm">
            <span className="text-destructive font-medium">Upgrade storage and resume backups</span>
            <Button className="text-destructive" variant="link">
                Learn more
                <ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" />
            </Button>
        </div>
        <Button aria-label="Close" className="absolute end-2 top-2" size="icon" variant="ghost">
            <XIcon aria-hidden="true" />
        </Button>
    </Card>
);

const DeployCard = () => (
    <Card className="w-full max-w-sm gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Production deploy finished for api-gateway v2.4.1</CardTitle>
                <ChevronRightIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0 rtl:rotate-180" />
            </div>
            <CardDescription className="text-xs">
                All 12 services passed their health checks. The rollout took 3 minutes 42 seconds, with no errors reported.
            </CardDescription>
        </div>
        <div className="border-border flex flex-wrap gap-2 border-t px-4 py-2">
            <Badge className="bg-info/15 text-info-foreground">Production</Badge>
            <Badge variant="outline">v2.4.1</Badge>
            <Badge variant="outline">3m 42s</Badge>
        </div>
    </Card>
);

const meta = {
    title: "UI/Notification cards",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Invoice: Story = {
    play: async ({ canvas }) => {
        expect(canvas.getByText("Invoice INV-0412 from Acme Inc.")).toBeInTheDocument();
    },
    render: () => <InvoiceCard />,
};

export const StorageLimit: Story = {
    play: async ({ canvas }) => {
        expect(canvas.getByText("Storage limit warning")).toBeInTheDocument();
    },
    render: () => <StorageCard />,
};

export const Deploy: Story = {
    play: async ({ canvas }) => {
        expect(canvas.getByText("Production")).toBeInTheDocument();
    },
    render: () => <DeployCard />,
};
