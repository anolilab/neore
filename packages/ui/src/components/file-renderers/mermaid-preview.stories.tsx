import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import MermaidPreview from "./mermaid-preview";

const dataUrl = (text: string): string => `data:text/vnd.mermaid;charset=utf-8,${encodeURIComponent(text)}`;

const FLOWCHART = ["flowchart LR", "    Draft --> Review", "    Review --> Approved", "    Review --> Draft", "    Approved --> Published"].join("\n");

const SEQUENCE = ["sequenceDiagram", "    participant U as User", "    participant A as App", "    U->>A: Send message", "    A-->>U: Stream reply"].join("\n");

const meta = {
    args: { filename: "flow.mmd", url: dataUrl(FLOWCHART) },
    component: MermaidPreview,
    title: "UI/Files/MermaidPreview",
} satisfies Meta<typeof MermaidPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Flowchart: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Show source")).toBeVisible();
    },
};

export const SequenceDiagram: Story = { args: { filename: "sequence.mmd", url: dataUrl(SEQUENCE) } };

/** The raw source sits behind a disclosure. */
export const SourceOpen: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByText("Show source"));
        await expect(await canvas.findByText(/Review --> Approved/u)).toBeVisible();
    },
};

export const Unreadable: Story = {
    args: { url: "https://example.invalid/flow.mmd" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download")).toBeVisible();
    },
};
