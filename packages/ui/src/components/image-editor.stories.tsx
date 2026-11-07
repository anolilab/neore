import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect, fn, screen } from "storybook/test";

import ImageEditor from "./image-editor";

const makeImageFile = (): Promise<File> =>
    new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");

        canvas.width = 320;
        canvas.height = 200;

        const context = canvas.getContext("2d");

        if (!context) {
            reject(new Error("2D canvas context unavailable"));

            return;
        }

        const gradient = context.createLinearGradient(0, 0, 320, 200);

        gradient.addColorStop(0, "#6366f1");
        gradient.addColorStop(1, "#f59e0b");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 200);
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(new File([blob], "gradient.png", { type: "image/png" }));
            } else {
                reject(new Error("Could not encode the image"));
            }
        }, "image/png");
    });

interface HarnessProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (file: File) => void;
    withFile?: boolean;
}

const Harness = ({ withFile = true, ...props }: HarnessProps) => {
    const [file, setFile] = useState<File | null>(null);

    useEffect(() => {
        if (!withFile) {
            return;
        }

        makeImageFile()
            .then(setFile)
            .catch(() => setFile(null));
    }, [withFile]);

    return <ImageEditor {...props} originalFile={file} />;
};

const meta = {
    args: { isOpen: true, onClose: fn(), onSave: fn() },
    component: Harness,
    title: "UI/Image editor/Image editor",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async () => {
        await expect(await screen.findByRole("dialog")).toBeInTheDocument();
    },
};

export const WithoutFile: Story = {
    args: { withFile: false },
};

export const Closed: Story = {
    args: { isOpen: false },
    play: async () => {
        await expect(screen.queryByRole("dialog")).toBeNull();
    },
};
