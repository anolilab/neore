import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import DocumentArtifact from "./document-artifact";

const CSV = ["region,q1,q2,q3", "North,120,135,150", "South,98,110,104", "West,143,150,171"].join("\n");

const meta = {
    args: { documentId: "doc-1", kind: "text", onOpen: fn(), onPreload: fn(), title: "Launch announcement", version: 3 },
    argTypes: { kind: { control: "select", options: ["text", "code", "sheet", "image", "design"] } },
    component: DocumentArtifact,
    decorators: [
        (Story) => (
            <div className="max-w-sm">
                <Story />
            </div>
        ),
    ],
    title: "Chat/DocumentArtifact",
} satisfies Meta<typeof DocumentArtifact>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Text: Story = {
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("Document · v3")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: /Launch announcement/u }));
        await expect(args.onOpen).toHaveBeenCalledWith("doc-1");
    },
};

/** Focusing a code card preloads the editor. */
export const Code: Story = {
    args: { kind: "code", language: "typescript", title: "retry-policy.ts" },
    play: async ({ args, canvas }) => {
        await userEvent.tab();
        await expect(canvas.getByRole("button", { name: /retry-policy\.ts/u })).toHaveFocus();
        await expect(args.onPreload).toHaveBeenCalled();
        await expect(canvas.getByText("Code · typescript · v3")).toBeVisible();
    },
};

export const Spreadsheet: Story = {
    args: { kind: "sheet", sheetContent: CSV, title: "Regional sales" },
};

export const Image: Story = { args: { kind: "image", title: "Hero banner", version: 1 } };

export const Design: Story = { args: { kind: "design", title: "Pricing page", version: 2 } };

export const Active: Story = { args: { isActive: true } };

export const UnknownKind: Story = { args: { kind: "notebook", title: "Analysis" } };
