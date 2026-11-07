import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import { TiptapCanvasEditor } from "./tiptap-canvas-editor";

const MARKDOWN = `# Project plan

A short plan with **bold**, _italic_ and \`code\`.

- [x] Draft the outline
- [ ] Review with the team

> Quote from the kickoff call.
`;

const TABLE_MARKDOWN = `| Step | Owner |
| ---- | ----- |
| Draft | Ada |
| Review | Grace |
`;

const meta = {
    args: { content: MARKDOWN, onSave: fn() },
    component: TiptapCanvasEditor,
    decorators: [
        (Story) => (
            <div className="h-[480px]">
                <Story />
            </div>
        ),
    ],
    title: "UI/Editors/Tiptap canvas editor",
} satisfies Meta<typeof TiptapCanvasEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Project plan")).toBeVisible();
    },
};

export const WithoutToolbar: Story = {
    args: { toolbar: false },
};

export const ReadOnly: Story = {
    args: { editable: false },
};

export const Empty: Story = {
    args: { content: "" },
};

export const WithTable: Story = {
    args: { content: TABLE_MARKDOWN },
};
