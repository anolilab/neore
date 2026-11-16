import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { CsvRenderer } from "./csv-renderer";

const CSV = `name,city,age,member
Ada,Berlin,31,true
Grace,Lisbon,27,false
Linus,Oslo,45,true
Margaret,Boston,52,true
Alan,London,41,false
Barbara,Seattle,38,true`;

const MANY_ROWS = `id,label\n${Array.from({ length: 120 }, (_, index) => `${index + 1},Row ${index + 1}`).join("\n")}`;

const meta = {
    args: { content: CSV },
    component: CsvRenderer,
    title: "UI/Files/CSV renderer",
} satisfies Meta<typeof CsvRenderer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Berlin")).toBeVisible();
    },
};

export const Compact: Story = {
    args: { compact: true, containerHeight: 160 },
};

export const SemicolonDelimiter: Story = {
    args: { content: CSV.replaceAll(",", ";"), delimiter: ";" },
};

export const Paginated: Story = {
    args: { content: MANY_ROWS },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Row 1")).toBeVisible();
    },
};

export const Search: Story = {
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox"), "Oslo");
        await expect(await canvas.findByText("Linus")).toBeVisible();
    },
};

export const NoMatches: Story = {
    play: async ({ canvas }) => {
        await userEvent.type(await canvas.findByRole("textbox"), "zzzz");
        await expect(await canvas.findByText(/No results found/)).toBeVisible();
    },
};

export const Empty: Story = {
    args: { content: "" },
};
