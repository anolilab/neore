import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import type { MediaItem } from "./media-preview-dialog";
import { MediaPreviewDialog, MediaPreviewDialogContent, MediaPreviewDialogFooter, MediaPreviewPanel, MediaPreviewSettingsPanel } from "./media-preview-dialog";

const imageSource = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#3b5bdb"/><circle cx="320" cy="240" r="120" fill="#fcc419"/></svg>',
)}`;

const image: MediaItem = {
    alt: "A yellow sun on a blue sky",
    aspectRatio: "4:3",
    id: "image-1",
    prompt: "A flat illustration of a yellow sun over a blue sky",
    src: imageSource,
    type: "image",
};

const meta: Meta<typeof MediaPreviewDialog> = {
    args: { media: image, onOpenChange: fn(), open: true },
    component: MediaPreviewDialog,
    render: (args) => (
        <MediaPreviewDialog {...args}>
            <MediaPreviewDialogContent>
                <MediaPreviewPanel />
                <MediaPreviewSettingsPanel description="Adjust and regenerate." title="Image settings">
                    <p className="text-sm">Style: flat illustration</p>
                </MediaPreviewSettingsPanel>
            </MediaPreviewDialogContent>
            <MediaPreviewDialogFooter onSubmit={fn()} />
        </MediaPreviewDialog>
    ),
    title: "UI/Media preview dialog",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Image: Story = {
    play: async () => {
        await expect(await screen.findByRole("button", { name: "Download" })).toBeInTheDocument();
        await expect(screen.getByText("Original Prompt")).toBeInTheDocument();
    },
};

export const Video: Story = {
    args: { media: { aspectRatio: "16:9", id: "video-1", src: "", type: "video" } },
    play: async () => {
        await expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
    },
};

export const Submitting: Story = {
    play: async () => {
        await expect(await screen.findByRole("button", { name: "Generating..." })).toBeDisabled();
    },
    render: (args) => (
        <MediaPreviewDialog {...args}>
            <MediaPreviewDialogContent>
                <MediaPreviewPanel />
                <MediaPreviewSettingsPanel title="Image settings" />
            </MediaPreviewDialogContent>
            <MediaPreviewDialogFooter isSubmitting onSubmit={fn()} />
        </MediaPreviewDialog>
    ),
};

export const NoMedia: Story = {
    args: { media: null },
    render: (args) => (
        <MediaPreviewDialog {...args}>
            <MediaPreviewDialogContent>
                <MediaPreviewPanel />
                <MediaPreviewSettingsPanel title="Image settings" />
            </MediaPreviewDialogContent>
        </MediaPreviewDialog>
    ),
};

export const CloseCallsBack: Story = {
    play: async ({ args }) => {
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    },
};
