import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { HexViewer } from "./hex-viewer";

/** The 8-byte PNG signature followed by a few ASCII bytes, so the file type is detected. */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const TEXT = new TextEncoder().encode("Hex viewers show the raw bytes of a file next to their ASCII form.\n");

const ramp = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => index % 256);

const meta = {
    args: { data: TEXT },
    component: HexViewer,
    decorators: [
        (Story) => (
            <div className="max-w-3xl rounded-lg border p-3">
                <Story />
            </div>
        ),
    ],
    title: "UI/Files/HexViewer",
} satisfies Meta<typeof HexViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText(`${TEXT.length} bytes`)).toBeVisible();
        await expect(canvas.getByText("00000000")).toBeVisible();
    },
};

/** The first bytes name a known file type. */
export const DetectedFileType: Story = {
    args: { data: PNG_HEAD },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("16 bytes")).toBeVisible();
    },
};

export const EightBytesPerRow: Story = { args: { bytesPerRow: 8 } };

/** Beyond `maxInitialRows` a button reveals the rest. */
export const ManyRows: Story = {
    args: { data: ramp(2048), maxInitialRows: 8 },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Show up to/u }));
        await expect(canvas.queryByRole("button", { name: /Show up to/u })).toBeNull();
    },
};

export const Empty: Story = { args: { data: new ArrayBuffer(0) } };
