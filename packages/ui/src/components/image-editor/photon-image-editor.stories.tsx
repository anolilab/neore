import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor } from "storybook/test";

import { PhotonImageEditor } from "./photon-image-editor";

const makeImageDataUrl = (): string => {
    const canvas = document.createElement("canvas");

    canvas.width = 320;
    canvas.height = 200;

    const context = canvas.getContext("2d");

    if (context) {
        const gradient = context.createLinearGradient(0, 0, 320, 200);

        gradient.addColorStop(0, "#6366f1");
        gradient.addColorStop(1, "#f59e0b");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 200);
    }

    return canvas.toDataURL("image/png");
};

const meta = {
    args: { onDirty: fn(), onSave: fn(), src: "" },
    component: PhotonImageEditor,
    render: (args) => <PhotonImageEditor {...args} src={args.src || makeImageDataUrl()} />,
    title: "UI/Image editor/Photon image editor",
} satisfies Meta<typeof PhotonImageEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: { title: "Gradient" },
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(canvasElement.querySelector("canvas")).not.toBeNull(), { timeout: 15_000 });
    },
};

export const BrokenSource: Story = {
    args: { src: "data:image/png;base64,AAAA" },
};
