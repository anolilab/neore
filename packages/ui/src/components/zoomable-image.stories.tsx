import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor } from "storybook/test";

import { ZoomableImage } from "./zoomable-image";

const picture = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2f5d9b"/><circle cx="400" cy="250" r="140" fill="#e0b340"/><text x="400" y="262" font-size="40" text-anchor="middle" fill="#1b1b1b">Zoom me</text></svg>`,
)}`;

// A zoom step is ignored until the image has layout, so a play that clicks first races the load.
const imageLaidOut = async (canvas: { getByRole: (role: "img") => HTMLElement }) => {
    await waitFor(() => expect(canvas.getByRole("img").offsetWidth).toBeGreaterThan(0));
};

const meta: Meta<typeof ZoomableImage> = {
    args: { alt: "Blue poster with a yellow circle", onError: fn(), src: picture },
    component: ZoomableImage,
    decorators: [
        (Story) => (
            <div className="h-80 w-full max-w-xl">
                <Story />
            </div>
        ),
    ],
    title: "UI/Zoomable image",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("group", { name: "Blue poster with a yellow circle" })).toBeVisible();
    },
};

export const ZoomIn: Story = {
    play: async ({ canvas }) => {
        await imageLaidOut(canvas);
        await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
        await waitFor(() => expect(canvas.getByRole("status")).not.toBeEmptyDOMElement());
    },
};

export const ZoomedThenReset: Story = {
    play: async ({ canvas }) => {
        await imageLaidOut(canvas);
        await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
        await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
        await userEvent.click(canvas.getByRole("button", { name: "Reset zoom" }));
        await expect(canvas.getByRole("button", { name: "Zoom out" })).toBeVisible();
    },
};

export const BrokenImage: Story = {
    args: { alt: "Missing picture", src: "data:image/svg+xml;utf8,not-an-image" },
    play: async ({ args }) => {
        await waitFor(() => expect(args.onError).toHaveBeenCalled());
    },
};
