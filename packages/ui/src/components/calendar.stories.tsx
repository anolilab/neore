import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Calendar } from "./calendar";

// November 2026, the month the story clock is pinned to.
const MONTH = new Date(2026, 10, 1);

const meta = {
    component: Calendar,
    title: "UI/Calendar",
} satisfies Meta<typeof Calendar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("grid")).toBeVisible();
    },
    render: () => <Calendar defaultMonth={MONTH} mode="single" />,
};

export const WithSelectedDay: Story = {
    render: () => <Calendar defaultMonth={MONTH} mode="single" selected={new Date(2026, 10, 12)} />,
};

export const RangeSelection: Story = {
    render: () => <Calendar defaultMonth={MONTH} mode="range" selected={{ from: new Date(2026, 10, 9), to: new Date(2026, 10, 13) }} />,
};
