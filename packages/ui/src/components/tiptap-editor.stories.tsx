import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { TiptapEditor, TiptapEditorMinimal } from "./tiptap-editor";

const CONTENT = "<h2>Release notes</h2><p>Storybook now covers the <strong>editors</strong>.</p><ul><li>Rich text</li><li>Task lists</li></ul>";

const meta = {
    args: { content: CONTENT, onChange: fn() },
    component: TiptapEditor,
    title: "UI/Editors/Tiptap editor",
} satisfies Meta<typeof TiptapEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Release notes")).toBeVisible();
    },
};

export const Empty: Story = {
    args: { content: "", placeholder: "Write something..." },
};

export const WithCharacterCount: Story = {
    args: { maxLength: 200, showCharacterCount: true },
};

export const ReadOnly: Story = {
    args: { editable: false },
};

export const Minimal: Story = {
    render: (args) => <TiptapEditorMinimal {...args} />,
};

export const Typing: Story = {
    args: { content: "" },
    play: async ({ args, canvasElement }) => {
        const editable = canvasElement.querySelector<HTMLElement>("[contenteditable=true]");

        await expect(editable).not.toBeNull();
        await userEvent.click(editable as HTMLElement);
        await userEvent.keyboard("Hello");
        await expect(args.onChange).toHaveBeenCalled();
    },
};
