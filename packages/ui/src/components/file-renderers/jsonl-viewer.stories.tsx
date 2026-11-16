import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import JsonlViewer from "./jsonl-viewer";

const dataUrl = (text: string): string => `data:application/x-ndjson;charset=utf-8,${encodeURIComponent(text)}`;

const RECORDS = [
    { event: "signup", id: 1, user: { name: "Ada", plan: "pro" } },
    { event: "message", id: 2, tokens: 412, user: { name: "Grace", plan: "free" } },
    { event: "export", format: "csv", id: 3, user: { name: "Linus", plan: "pro" } },
];

const LINES = RECORDS.map((record) => JSON.stringify(record)).join("\n");

const meta = {
    args: { filename: "events.jsonl", url: dataUrl(LINES) },
    component: JsonlViewer,
    title: "UI/Files/JsonlViewer",
} satisfies Meta<typeof JsonlViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("3 records")).toBeVisible();
        await expect(canvas.getByText("Line 2")).toBeVisible();
    },
};

/** Lines that are not JSON are listed by number above the records. */
export const WithInvalidLines: Story = {
    args: { url: dataUrl(`${LINES}\nnot json at all\n{"id": 4, "event": "login"}`) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("list", { name: "Lines that are not valid JSON" })).toBeVisible();
        await expect(canvas.getByText("4 records")).toBeVisible();
    },
};

export const SingleRecord: Story = {
    args: { filename: "one.jsonl", url: dataUrl('{"ok":true}') },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("1 record")).toBeVisible();
    },
};

/** A file past the 200-record cap stops reading and says so. */
export const Truncated: Story = {
    args: {
        filename: "large.jsonl",
        url: dataUrl(Array.from({ length: 250 }, (_, index) => JSON.stringify({ id: index + 1 })).join("\n")),
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/The preview stops after 200 records/u)).toBeVisible();
    },
};

export const Unreadable: Story = {
    args: { url: "https://example.invalid/events.jsonl" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download")).toBeVisible();
    },
};
