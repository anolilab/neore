/**
 * Chat document attachments end to end, against the mock model: the PDF is
 * uploaded over TUS to the backend's upload route (`POST /uploads`, then
 * `PATCH`es of 5 MiB chunks) and taken in by `file.finalizeChatUpload`, its
 * text is extracted by the Rust
 * document-parser Worker over the backend's service binding, and `/chat/start`
 * puts that text in front of the prompt — which the mock echoes back. A
 * document over the 25 MB cap is refused in the composer before any upload.
 *
 * The bytes used to ride base64 inside a JSON RPC body, which Lunora caps at
 * 1 MiB: anything over ~750 KB failed with a 413. The 3 MB case pins that.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { composer, expect, expectAssistantReply, openChat, REPLY_TIMEOUT, sendMessage, test } from "./chat-helpers";

const SAMPLE_PDF = readFileSync(new URL("../../../services/document-parser/test/fixtures/sample.pdf", import.meta.url));

/** 25 MiB — `MAX_EXTRACTION_DOCUMENT_BYTES` (backend) = `MAX_DOCUMENT_BYTES` (parser). */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * A valid one-page PDF showing `text`, made `paddingBytes` larger by an
 * unreferenced stream of random (incompressible) bytes, with a correct xref.
 */
const buildPdf = (text: string, paddingBytes: number): Buffer => {
    const parts: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;
    const push = (chunk: Buffer | string): void => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;

        parts.push(buffer);
        length += buffer.length;
    };
    const stream = (body: Buffer | string): (Buffer | string)[] => {
        const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;

        return [`<< /Length ${String(bytes.length)} >>\nstream\n`, bytes, "\nendstream"];
    };
    const objects: (Buffer | string)[][] = [
        ["<< /Type /Catalog /Pages 2 0 R >>"],
        ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
        ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
        stream(`BT /F1 18 Tf 72 720 Td (${text}) Tj ET`),
        ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
        stream(randomBytes(paddingBytes)),
    ];

    push("%PDF-1.4\n%âãÏÓ\n");

    for (const [index, object] of objects.entries()) {
        offsets.push(length);
        push(`${String(index + 1)} 0 obj\n`);

        for (const chunk of object) {
            push(chunk);
        }

        push("\nendobj\n");
    }

    const xref = length;

    push(`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`);

    for (const offset of offsets) {
        push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }

    push(`trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`);

    return Buffer.concat(parts);
};

const attach = async (page: Page, file: { buffer: Buffer; mimeType: string; name: string }): Promise<void> => {
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    await page.locator('input[type="file"]').first().setInputFiles(file);
};

/**
 * Waits until the attachment is uploaded AND its text extracted. Sent before
 * extraction lands, `/chat/start` attaches the raw PDF instead of its text; the
 * chip polls `file.getChatFileExtraction` and mirrors it on
 * `data-extraction-status`.
 */
const expectExtracted = async (page: Page, name: string): Promise<void> => {
    const chip = page.locator(`[data-attachment-name="${name}"]`);

    await expect(chip).toHaveAttribute("data-attachment-status", "complete", { timeout: 60_000 });
    await expect(chip).toHaveAttribute("data-extraction-status", "completed", { timeout: 60_000 });
};

test.describe("Document upload (mock model)", () => {
    test("a PDF's extracted text reaches the conversation", async ({ userPage: page }) => {
        await openChat(page);
        await attach(page, { buffer: SAMPLE_PDF, mimeType: "application/pdf", name: "sample.pdf" });
        await expectExtracted(page, "sample.pdf");

        await sendMessage(page, "What does the document say?");

        // The mock echoes the start of the prompt, and the extracted text is
        // prepended to it as `[Document: sample.pdf]`.
        const reply = await expectAssistantReply(page, "Mock reply:");

        await expect(reply).toContainText("[Document: sample.pdf]", { timeout: REPLY_TIMEOUT });
        await expect(reply).toContainText("The capybara sits by the river.");
    });

    test("a 3 MB PDF uploads past the old 1 MiB RPC limit and its text reaches the conversation", async ({ userPage: page }) => {
        const pdf = buildPdf("The heron waits at the quiet lake.", 3 * 1024 * 1024);

        expect(pdf.length).toBeGreaterThan(3 * 1024 * 1024);

        await openChat(page);

        const chunk = page.waitForResponse((response) => response.url().includes("/uploads/") && response.request().method() === "PATCH");

        await attach(page, { buffer: pdf, mimeType: "application/pdf", name: "heron.pdf" });

        // The bytes went straight to storage through the upload route.
        expect((await chunk).status()).toBe(204);

        await expectExtracted(page, "heron.pdf");

        await sendMessage(page, "Summarise the attached document.");

        const reply = await expectAssistantReply(page, "Mock reply:");

        await expect(reply).toContainText("[Document: heron.pdf]", { timeout: REPLY_TIMEOUT });
        await expect(reply).toContainText("The heron waits at the quiet lake.");
    });

    test("a 20 MB PDF, past the 16 MiB a single buffered put could take, uploads in resumable chunks", async ({ userPage: page }) => {
        const pdf = buildPdf("The otter floats on its back.", 20 * 1024 * 1024);
        const chunks: number[] = [];

        page.on("response", (response) => {
            if (response.url().includes("/uploads/") && response.request().method() === "PATCH") {
                chunks.push(response.status());
            }
        });

        await openChat(page);
        await attach(page, { buffer: pdf, mimeType: "application/pdf", name: "otter.pdf" });
        await expectExtracted(page, "otter.pdf");

        // 5 MiB per PATCH: five of them, every one accepted.
        expect(chunks).toStrictEqual([204, 204, 204, 204, 204]);
    });

    test("a document over 25 MB is refused in the composer", async ({ userPage: page }) => {
        await openChat(page);
        await attach(page, { buffer: Buffer.alloc(MAX_DOCUMENT_BYTES + 1), mimeType: "application/pdf", name: "too-large.pdf" });

        await expect(page.getByText('"too-large.pdf" is too large. Documents can be at most 25 MB.')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('[data-attachment-name="too-large.pdf"]')).toHaveAttribute("data-attachment-status", "error");
    });
});
