import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import { Artifact, ArtifactAction, ArtifactActions, ArtifactClose, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "./artifact";

const meta = {
    component: Artifact,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Artifact",
} satisfies Meta<typeof Artifact>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => (
        <Artifact>
            <ArtifactHeader>
                <div>
                    <ArtifactTitle>Quarterly summary</ArtifactTitle>
                    <ArtifactDescription>Updated just now</ArtifactDescription>
                </div>
            </ArtifactHeader>
            <ArtifactContent>
                <p className="text-sm">Revenue grew 12% quarter over quarter, driven by the new team plan.</p>
            </ArtifactContent>
        </Artifact>
    ),
};

export const WithActions: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Close" })).toBeVisible();
    },
    render: () => {
        const onClose = fn();
        const onCopy = fn();

        return (
            <Artifact>
                <ArtifactHeader>
                    <div>
                        <ArtifactTitle>Quarterly summary</ArtifactTitle>
                        <ArtifactDescription>Markdown document</ArtifactDescription>
                    </div>
                    <ArtifactActions>
                        <ArtifactAction icon={CopyIcon} label="Copy" onClick={onCopy} />
                        <ArtifactAction icon={DownloadIcon} label="Download" />
                        <ArtifactClose onClick={onClose} />
                    </ArtifactActions>
                </ArtifactHeader>
                <ArtifactContent>
                    <p className="text-sm">Revenue grew 12% quarter over quarter, driven by the new team plan.</p>
                </ArtifactContent>
            </Artifact>
        );
    },
};

export const WithTooltipAction: Story = {
    play: async ({ canvas }) => {
        const action = canvas.getByRole("button", { name: "Copy to clipboard" });

        await userEvent.hover(action);
        await expect(action).toBeVisible();
    },
    render: () => (
        <Artifact>
            <ArtifactHeader>
                <ArtifactTitle>Snippet</ArtifactTitle>
                <ArtifactActions>
                    <ArtifactAction icon={CopyIcon} tooltip="Copy to clipboard" />
                </ArtifactActions>
            </ArtifactHeader>
            <ArtifactContent>
                <pre className="text-sm">const total = items.length;</pre>
            </ArtifactContent>
        </Artifact>
    ),
};

export const LongContent: Story = {
    render: () => (
        <Artifact className="h-48">
            <ArtifactHeader>
                <ArtifactTitle>Long document</ArtifactTitle>
                <ArtifactClose />
            </ArtifactHeader>
            <ArtifactContent aria-label="Document body" role="region" tabIndex={0}>
                {Array.from({ length: 12 }, (_, index) => (
                    <p className="mb-2 text-sm" key={index}>
                        Paragraph {index + 1}: the content scrolls inside the artifact while the header stays in place.
                    </p>
                ))}
            </ArtifactContent>
        </Artifact>
    ),
};
