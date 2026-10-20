import type { Doc } from "@neore/backend/dataModel";

import { buildDocx, DOCX_MIME_TYPE } from "./docx";

type Message = Doc<"messages">;
type Chat = Doc<"threads">;

export type DownloadFormat = "docx" | "json" | "md" | "txt" | "pdf";

/**
 * `Doc<"messages">.message` is an untyped JSON blob (a persisted AI SDK core message).
 * This is the slice the exporters read out of it.
 */
interface StoredToolOutput {
    reason?: string;
    type?: string;
    value?: unknown;
}

interface StoredMessagePayload {
    content?: { content?: string; output?: StoredToolOutput; text?: string }[];
    role?: string;
}

/**
 * One part of a `content` tool output (text, or an image or file). Binary parts carry their bytes in `data`, which
 * is never written out: the export says what the part was.
 */
interface StoredContentPart {
    mediaType?: string;
    text?: string;
    type?: string;
}

/** A content part as text: its text, or a placeholder for an image or file, so a base64 payload never reaches an export. */
const contentPartText = (part: StoredContentPart): string => {
    if (part.type === "text") {
        return part.text ?? "";
    }

    const kind = part.type?.startsWith("image") ? "image" : "file";

    return part.mediaType ? `[${kind}: ${part.mediaType}]` : `[${kind}]`;
};

/**
 * A stored tool output as text, by its type. Only a missing output is absent: a `null` value is written as `null`.
 * Structured output is JSON; a `content` output keeps its text and names its images and files.
 */
const toolOutputText = (output: StoredToolOutput | undefined): string | undefined => {
    if (output === undefined) {
        return undefined;
    }

    const { type, value } = output;

    if (type === "content" && Array.isArray(value)) {
        return value.map((part: StoredContentPart) => contentPartText(part)).join("\n");
    }

    if ((type === "text" || type === "error-text") && typeof value === "string") {
        return value;
    }

    // A denied approval has no value; its explanation is the reason the user (or the policy) gave.
    if (type === "execution-denied") {
        return output.reason ?? "Tool execution denied";
    }

    return JSON.stringify(value);
};

const getStoredMessage = (message: Message): StoredMessagePayload | undefined => message.message as StoredMessagePayload | undefined;

/** Every tool-result part as text, in stored order. A reply with no readable output falls back to the row's text. */
const toolResultText = (message: Message, stored: StoredMessagePayload | undefined): string => {
    const parts = (stored?.content ?? []).map((part) => toolOutputText(part.output) ?? part.content).filter((part): part is string => part !== undefined);

    return parts.length > 0 ? parts.join("\n") : (message.text ?? "No result");
};

/** A persisted assistant message that holds a tool call carries the tool flag too; only a reply to one is a tool output. */
const isToolReply = (message: Message, stored: StoredMessagePayload | undefined): boolean => Boolean(message.tool) && stored?.role !== "assistant";

/** A message as the exporters print it: who said it, and what. */
const toEntry = (message: Message): { role: string; text: string } => {
    const stored = getStoredMessage(message);

    if (isToolReply(message, stored)) {
        return { role: "Tool Output", text: toolResultText(message, stored) };
    }

    const role: string = stored?.role ?? "assistant";

    return {
        role: role.charAt(0).toUpperCase() + role.slice(1),
        text: message.text ?? stored?.content?.map((c) => c.text).join("\n") ?? "",
    };
};

const formatMessage = (message: Message): string => {
    const { role, text } = toEntry(message);

    return `${role}: ${text}`;
};

/** Format thread + messages as a markdown string. Exported for clipboard copy. */
export const formatAsMarkdown = (thread: Chat, messages: Message[]): string => {
    const sortedMessages = messages.toSorted((a, b) => a._creationTime - b._creationTime);
    const title = thread.title || "Untitled Chat";
    const lines: string[] = [`# ${title}`, "", `_${new Date(thread._creationTime).toLocaleString()}_`, "", "---", ""];

    for (const message of sortedMessages) {
        const stored = getStoredMessage(message);

        if (isToolReply(message, stored)) {
            const toolResult = toolResultText(message, stored).split("\n");

            lines.push(`> **Tool Output**`, ...toolResult.map((line) => `> ${line}`), "");

            continue;
        }

        const role: string = stored?.role ?? "assistant";
        const textContent: string = message.text ?? stored?.content?.map((c) => c.text).join("\n") ?? "";

        lines.push(`### ${role.charAt(0).toUpperCase() + role.slice(1)}`, "", textContent, "");
    }

    return lines.join("\n");
};

/** Saves a blob through a temporary object URL. The URL is revoked on the next task: some browsers start the download asynchronously. */
export const saveBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = filename;
    // `appendChild`, not `append`: with the Workers types in scope, `append`
    // resolves to a FormData-ish overload that takes `string | Response |
    // ReadableStream` and rejects an element.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

const downloadMarkdown = (chat: Chat, messages: Message[], filename: string) => {
    const content = formatAsMarkdown(chat, messages);
    const blob = new Blob([content], { type: "text/markdown" });

    saveBlob(blob, filename);
};

const downloadJson = (chat: Chat, messages: Message[], filename: string) => {
    const data = { chat, messages };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
    });

    saveBlob(blob, filename);
};

const downloadTxt = (chat: Chat, messages: Message[], filename: string) => {
    const header = [`Title: ${chat.title || "Untitled Chat"}`, `Date: ${new Date(chat._creationTime).toLocaleString()}`, "---", ""];

    const messageLines = messages.map((message) => formatMessage(message));
    const content = [...header, ...messageLines].join("\n");

    const blob = new Blob([content], { type: "text/plain" });

    saveBlob(blob, filename);
};

const downloadDocx = async (chat: Chat, messages: Message[], filename: string) => {
    // JSZip is only needed once someone exports a Word document, so it stays off the chat route.
    const { default: JsZip } = await import("jszip");
    const bytes = await buildDocx(JsZip, {
        date: new Date(chat._creationTime).toLocaleString(),
        entries: messages.map((message) => toEntry(message)),
        title: chat.title || "Untitled Chat",
    });

    saveBlob(new Blob([bytes], { type: DOCX_MIME_TYPE }), filename);
};

const downloadPdf = async (chat: Chat, messages: Message[], filename: string) => {
    // jsPDF (~390KB) is only needed once someone exports a PDF, so it stays off the chat route.
    const { jsPDF: JsPdf } = await import("jspdf");
    const pdf = new JsPdf();
    const margin = 15;
    const pageWidth = pdf.internal.pageSize.getWidth();
    const usableWidth = pageWidth - margin * 2;
    let yPosition = margin;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text(chat.title || "Untitled Chat", margin, yPosition);
    yPosition += 10;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(`Date: ${new Date(chat._creationTime).toLocaleString()}`, margin, yPosition);
    yPosition += 10;
    pdf.line(margin, yPosition, pageWidth - margin, yPosition);
    yPosition += 10;

    messages.forEach((message) => {
        if (yPosition > 270) {
            pdf.addPage();
            yPosition = margin;
        }

        const rawRole: string = getStoredMessage(message)?.role ?? (message.tool ? "tool" : "assistant");
        const role = rawRole.charAt(0).toUpperCase() + rawRole.slice(1);
        const fullMessage = formatMessage(message);
        // Ensure that there is a ':' before extracting content
        const contentStartIndex = fullMessage.indexOf(":");
        const content = contentStartIndex === -1 ? fullMessage : fullMessage.slice(Math.max(0, contentStartIndex + 1)).trim();

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
        pdf.text(`${role}:`, margin, yPosition);

        pdf.setFont("helvetica", "normal");
        const textLines = pdf.splitTextToSize(content, usableWidth - 15);

        pdf.text(textLines, margin + 15, yPosition);

        yPosition += textLines.length * 5 + 5;
    });

    pdf.save(filename);
};

export const handleDownload = async (thread: Chat, messages: Message[], format: DownloadFormat): Promise<void> => {
    if (!messages || messages.length === 0) {
        console.error("No messages to download.");

        return;
    }

    const sortedMessages = messages.toSorted((a, b) => a._creationTime - b._creationTime);

    const title = thread.title || "Untitled Chat";
    const filename = `${title}.${format}`;

    switch (format) {
        case "docx": {
            await downloadDocx(thread, sortedMessages, filename);
            break;
        }
        case "json": {
            downloadJson(thread, sortedMessages, filename);
            break;
        }
        case "md": {
            downloadMarkdown(thread, sortedMessages, filename);
            break;
        }
        case "pdf": {
            await downloadPdf(thread, sortedMessages, filename);
            break;
        }
        case "txt": {
            downloadTxt(thread, sortedMessages, filename);
            break;
        }
        default: {
            console.error(`Unsupported download format: ${format}`);
        }
    }
};
