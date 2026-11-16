import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

const meta = {
    args: { size: "default" },
    argTypes: { size: { control: "inline-radio", options: ["default", "sm"] } },
    component: Card,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Card {...args}>
            <CardHeader>
                <CardTitle>API keys</CardTitle>
                <CardDescription>Keys let scripts and the neore CLI act as you.</CardDescription>
                <CardAction>
                    <Button size="sm" variant="outline">
                        Create key
                    </Button>
                </CardAction>
            </CardHeader>
            <CardContent>
                <p className="text-sm">You have no keys yet.</p>
            </CardContent>
            <CardFooter>
                <p className="text-muted-foreground text-xs">Keys expire after 90 days unless you choose otherwise.</p>
            </CardFooter>
        </Card>
    ),
    title: "UI/Card",
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = { args: { size: "sm" } };

export const ContentOnly: Story = {
    render: (args) => (
        <Card {...args}>
            <CardContent>
                <p className="text-sm">A card with only content and no header.</p>
            </CardContent>
        </Card>
    ),
};
