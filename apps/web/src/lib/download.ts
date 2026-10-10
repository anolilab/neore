import type { Doc } from "@neore/backend/dataModel";

type Message = Doc<"messages">;
type Chat = Doc<"threads">;

export type DownloadFormat = "json" | "md" | "txt" | "pdf";

/**
 * `Doc<"messages">.message` is an untyped JSON blob (a persisted AI SDK core message).
 * This is the slice the exporters read out of it.
 */
interface StoredMessagePayload {
    content?: { content?: string; text?: string }[];
    role?: string;
}

const getStoredMessage = (message: Message): StoredMessagePayload | undefined => message.message as StoredMessagePayload | undefined;

const formatMessage = (message: Message): string => {
    const stored = getStoredMessage(message);

    if (message.tool) {
        const toolResult = stored?.content?.[0]?.content ?? message.text ?? "No result";

        return `Tool Output: ${toolResult}`;
    }

    const role: string = stored?.role ?? (message.tool ? "tool" : "assistant");
    const textContent: string = message.text ?? stored?.content?.map((c) => c.text).join(String.raw`\n`) ?? "";

    return `${role.charAt(0).toUpperCase() + role.slice(1)}: ${textContent}`;
};

/** Format thread + messages as a markdown string. Exported for clipboard copy. */
export const formatAsMarkdown = (thread: Chat, messages: Message[]): string => {
    const sortedMessages = messages.toSorted((a, b) => a._creationTime - b._creationTime);
    const title = thread.title || "Untitled Chat";
    const lines: string[] = [`# ${title}`, "", `_${new Date(thread._creationTime).toLocaleString()}_`, "", "---", ""];

    for (const message of sortedMessages) {
        const stored = getStoredMessage(message);

        if (message.tool) {
            const toolResult = stored?.content?.[0]?.content ?? message.text ?? "No result";

            lines.push(`> **Tool Output**`, `> ${toolResult}`, "");

            continue;
        }

        const role: string = stored?.role ?? "assistant";
        const textContent: string = message.text ?? stored?.content?.map((c) => c.text).join("\n") ?? "";

        lines.push(`### ${role.charAt(0).toUpperCase() + role.slice(1)}`, "", textContent, "");
    }

    return lines.join("\n");
};

const triggerBrowserDownload = (blob: Blob, filename: string) => {
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
    URL.revokeObjectURL(url);
};

const downloadMarkdown = (chat: Chat, messages: Message[], filename: string) => {
    const content = formatAsMarkdown(chat, messages);
    const blob = new Blob([content], { type: "text/markdown" });

    triggerBrowserDownload(blob, filename);
};

const downloadJson = (chat: Chat, messages: Message[], filename: string) => {
    const data = { chat, messages };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
    });

    triggerBrowserDownload(blob, filename);
};

const downloadTxt = (chat: Chat, messages: Message[], filename: string) => {
    const header = [`Title: ${chat.title || "Untitled Chat"}`, `Date: ${new Date(chat._creationTime).toLocaleString()}`, "---", ""];

    const messageLines = messages.map((message) => formatMessage(message));
    const content = [...header, ...messageLines].join(String.raw`\n`);

    const blob = new Blob([content], { type: "text/plain" });

    triggerBrowserDownload(blob, filename);
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
