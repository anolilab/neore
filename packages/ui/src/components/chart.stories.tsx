import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis } from "recharts";
import { expect } from "storybook/test";

import type { ChartConfig } from "./chart";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "./chart";

const data = [
    { chats: 186, month: "Jan", tasks: 80 },
    { chats: 305, month: "Feb", tasks: 200 },
    { chats: 237, month: "Mar", tasks: 120 },
    { chats: 273, month: "Apr", tasks: 190 },
    { chats: 209, month: "May", tasks: 130 },
];

const config = {
    chats: { color: "#2563eb", label: "Chats" },
    tasks: { color: "#7c3aed", label: "Tasks" },
} satisfies ChartConfig;

const meta = {
    args: { children: <></>, className: "h-56 w-full max-w-lg", config },
    component: ChartContainer,
    title: "UI/Chart",
} satisfies Meta<typeof ChartContainer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Bars: Story = {
    play: async ({ canvasElement }) => {
        await expect(canvasElement.querySelector("[data-slot='chart']")).not.toBeNull();
    },
    render: (args) => (
        <ChartContainer {...args}>
            <BarChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="month" tickLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="chats" fill="var(--color-chats)" isAnimationActive={false} radius={4} />
            </BarChart>
        </ChartContainer>
    ),
};

export const GroupedWithLegend: Story = {
    render: (args) => (
        <ChartContainer {...args}>
            <BarChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="month" tickLine={false} />
                <ChartTooltip content={<ChartTooltipContent indicator="dashed" />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="chats" fill="var(--color-chats)" isAnimationActive={false} radius={4} />
                <Bar dataKey="tasks" fill="var(--color-tasks)" isAnimationActive={false} radius={4} />
            </BarChart>
        </ChartContainer>
    ),
};

export const Lines: Story = {
    render: (args) => (
        <ChartContainer {...args}>
            <LineChart accessibilityLayer data={data}>
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="month" tickLine={false} />
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Line dataKey="chats" dot={false} isAnimationActive={false} stroke="var(--color-chats)" strokeWidth={2} type="monotone" />
                <Line dataKey="tasks" dot={false} isAnimationActive={false} stroke="var(--color-tasks)" strokeWidth={2} type="monotone" />
            </LineChart>
        </ChartContainer>
    ),
};

export const Empty: Story = {
    render: (args) => (
        <ChartContainer {...args}>
            <BarChart accessibilityLayer data={[]}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" />
                <Bar dataKey="chats" fill="var(--color-chats)" isAnimationActive={false} />
            </BarChart>
        </ChartContainer>
    ),
};
