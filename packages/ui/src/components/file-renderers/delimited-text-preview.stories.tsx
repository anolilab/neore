import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import DelimitedTextPreview from "./delimited-text-preview";

const dataUrl = (text: string, type: string): string => `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

const CSV = ["name,team,city,seats", "Ada,Platform,London,4", "Grace,Compilers,New York,2", "Linus,Kernel,Portland,8", "Margaret,Flight,Boston,3"].join("\n");

const TSV = CSV.replaceAll(",", "\t");

const manyColumns = (count: number): string => {
    const header = Array.from({ length: count }, (_, index) => `col${index + 1}`);
    const row = Array.from({ length: count }, (_, index) => String(index + 1));

    return [header.join(","), row.join(",")].join("\n");
};

const meta = {
    args: { filename: "team.csv", url: dataUrl(CSV, "text/csv") },
    component: DelimitedTextPreview,
    title: "UI/Files/DelimitedTextPreview",
} satisfies Meta<typeof DelimitedTextPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Csv: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Margaret")).toBeVisible();
    },
};

export const Tsv: Story = {
    args: { filename: "team.tsv", url: dataUrl(TSV, "text/tab-separated-values") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Portland")).toBeVisible();
    },
};

/** Only the first 50 columns are shown, with a note for the rest. */
export const ManyColumns: Story = {
    args: { filename: "wide.csv", url: dataUrl(manyColumns(60), "text/csv") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("+10 more columns are not shown.")).toBeVisible();
    },
};

/** A file that cannot be read shows the download card. */
export const Unreadable: Story = {
    args: { url: "https://example.invalid/team.csv" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download")).toBeVisible();
    },
};
