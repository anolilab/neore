import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircleIcon, InfoIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";

const meta = {
    argTypes: { variant: { control: "inline-radio", options: ["default", "destructive"] } },
    component: Alert,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "UI/Alert",
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => (
        <Alert {...args}>
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>Your plan renews on the 1st of next month.</AlertDescription>
        </Alert>
    ),
};

export const Destructive: Story = {
    args: { variant: "destructive" },
    render: (args) => (
        <Alert {...args}>
            <AlertCircleIcon aria-hidden="true" />
            <AlertTitle>Payment failed</AlertTitle>
            <AlertDescription>We could not charge your card. Update it to keep your plan.</AlertDescription>
        </Alert>
    ),
};

export const WithoutIcon: Story = {
    render: (args) => (
        <Alert {...args}>
            <AlertTitle>Scheduled maintenance</AlertTitle>
            <AlertDescription>Chat may be unavailable for a few minutes on Sunday.</AlertDescription>
        </Alert>
    ),
};

export const WithAction: Story = {
    render: (args) => (
        <Alert {...args}>
            <AlertTitle>New version available</AlertTitle>
            <AlertDescription>Reload to get the latest changes.</AlertDescription>
            <AlertAction>
                <Button size="xs" variant="outline">
                    Reload
                </Button>
            </AlertAction>
        </Alert>
    ),
};
