import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { AttachmentData } from "./attachments";
import {
    Attachment,
    AttachmentEmpty,
    AttachmentHoverCard,
    AttachmentHoverCardContent,
    AttachmentHoverCardTrigger,
    AttachmentInfo,
    AttachmentPreview,
    AttachmentRemove,
    Attachments,
} from "./attachments";

const IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#7c6cf0"/><circle cx="48" cy="48" r="24" fill="#fff"/></svg>',
)}`;

const IMAGE_FILE: AttachmentData = { filename: "mountain.svg", id: "1", mediaType: "image/svg+xml", type: "file", url: IMAGE_URL };
const PDF_FILE: AttachmentData = { filename: "report.pdf", id: "2", mediaType: "application/pdf", type: "file", url: "https://example.com/report.pdf" };

const FILES: AttachmentData[] = [
    IMAGE_FILE,
    PDF_FILE,
    { filename: "voice-note.mp3", id: "3", mediaType: "audio/mpeg", type: "file", url: "https://example.com/voice-note.mp3" },
    { id: "4", mediaType: "text/html", sourceId: "src-1", title: "Pricing page", type: "source-document" },
];

const meta = {
    component: Attachments,
    title: "Chat/Attachments",
} satisfies Meta<typeof Attachments>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Grid: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "mountain.svg" })).toBeVisible();
    },
    render: () => (
        <Attachments variant="grid">
            {FILES.map((file) => (
                <Attachment data={file} key={file.id} onRemove={fn()}>
                    <AttachmentPreview />
                    <AttachmentRemove label={`Remove ${file.type === "file" ? file.filename : file.title}`} />
                </Attachment>
            ))}
        </Attachments>
    ),
};

export const Inline: Story = {
    render: () => (
        <Attachments variant="inline">
            {FILES.map((file) => (
                <Attachment data={file} key={file.id}>
                    <AttachmentPreview />
                    <AttachmentInfo />
                </Attachment>
            ))}
        </Attachments>
    ),
};

export const List: Story = {
    render: () => (
        <div className="w-96">
            <Attachments variant="list">
                {FILES.map((file) => (
                    <Attachment data={file} key={file.id}>
                        <AttachmentPreview />
                        <AttachmentInfo showMediaType />
                    </Attachment>
                ))}
            </Attachments>
        </div>
    ),
};

export const Removable: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Remove report.pdf" }));
    },
    render: () => {
        const onRemove = fn();

        return (
            <div className="w-96">
                <Attachments variant="list">
                    <Attachment data={PDF_FILE} onRemove={onRemove}>
                        <AttachmentPreview />
                        <AttachmentInfo />
                        <AttachmentRemove label="Remove report.pdf" />
                    </Attachment>
                </Attachments>
            </div>
        );
    },
};

export const WithHoverCard: Story = {
    render: () => (
        <Attachments variant="inline">
            <AttachmentHoverCard>
                <AttachmentHoverCardTrigger render={<span />}>
                    <Attachment data={IMAGE_FILE}>
                        <AttachmentPreview />
                        <AttachmentInfo />
                    </Attachment>
                </AttachmentHoverCardTrigger>
                <AttachmentHoverCardContent>
                    <img alt="Preview of mountain.svg" height={160} src={IMAGE_URL} width={160} />
                </AttachmentHoverCardContent>
            </AttachmentHoverCard>
        </Attachments>
    ),
};

export const Empty: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("No attachments")).toBeVisible();
    },
    render: () => (
        <Attachments variant="list">
            <AttachmentEmpty />
        </Attachments>
    ),
};
