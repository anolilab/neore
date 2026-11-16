/* eslint-disable no-secrets/no-secrets -- Office XML namespaces and content types, not secrets */
import type { Meta, StoryObj } from "@storybook/react-vite";
import JSZip from "jszip";
import { expect, userEvent } from "storybook/test";

import { PptxPreview } from "./pptx-preview";

const escapeXml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const slideXml = (lines: string[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${lines
        .map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p></p:txBody></p:sp>`)
        .join("")}</p:spTree></p:cSld></p:sld>`;

/** A minimal deck: the preview only reads the text of `ppt/slides/slideN.xml`. */
const buildDeck = async (slides: string[][]): Promise<ArrayBuffer> => {
    const zip = new JSZip();

    for (const [index, lines] of slides.entries()) {
        zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(lines));
    }

    // A deck with no slide still needs one entry to be a valid archive.
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');

    return await zip.generateAsync({ type: "arraybuffer" });
};

const DECK = [
    ["Quarterly review", "Prepared by the platform team"],
    ["Highlights", "Launch shipped two weeks early", "Latency down 30%", "Support volume flat"],
    ["Next quarter", "Offline mode", "Shared workspaces"],
    [],
];

const meta = {
    args: { data: new ArrayBuffer(0), fileName: "review.pptx" },
    component: PptxPreview,
    loaders: [
        async () => {
            return { deck: await buildDeck(DECK), empty: await buildDeck([]) };
        },
    ],
    title: "UI/Files/PptxPreview",
} satisfies Meta<typeof PptxPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("4 slides", { exact: false })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Previous slide" })).toBeDisabled();
    },
    render: (args, { loaded }) => <PptxPreview {...args} data={loaded.deck as ArrayBuffer} />,
};

export const BrowsingSlides: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Next slide" }));
        await expect(canvas.getByText("2 / 4")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: /Slide 4/u }));
        await expect(canvas.getByText("No text content on this slide")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Next slide" })).toBeDisabled();
    },
    render: (args, { loaded }) => <PptxPreview {...args} data={loaded.deck as ArrayBuffer} />,
};

export const NoSlides: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No slides found in this presentation.")).toBeVisible();
    },
    render: (args, { loaded }) => <PptxPreview {...args} data={loaded.empty as ArrayBuffer} />,
};

/** Bytes that are not a ZIP archive show the parser's error. */
export const NotAPresentation: Story = {
    args: { data: new TextEncoder().encode("this is not a presentation").buffer },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/^Error:/u)).toBeVisible();
    },
};
