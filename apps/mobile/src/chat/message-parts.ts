/** The `type` of one stored message part; undefined for a value that is not an object. */
const partKind = (part: unknown): unknown => {
    if (typeof part !== "object" || part === null) {
        return undefined;
    }

    return (part as { type?: unknown }).type;
};

/** What one stored message part shows: its text, or a label for an attachment. */
const partText = (part: unknown): string => {
    const kind = partKind(part);

    if (kind === "text") {
        return String((part as { text?: unknown }).text ?? "");
    }

    return kind === "image" || kind === "file" ? "[Attachment]" : "";
};

/** What the reader shows for a message: its text, with a label where an attachment is. */
export const displayTextOf = (parts: unknown[]): string => parts.map((part) => partText(part)).join("");

/**
 * Whether a text part carries the page the user attached to the message. Its text is the serialized page, which is
 * not the prompt, so it is never shared.
 */
const isPageContext = (part: unknown): boolean => {
    const metadata = (part as { providerMetadata?: { neore?: { pageContext?: unknown } } } | null)?.providerMetadata;

    return metadata?.neore?.pageContext !== undefined;
};

/**
 * The typed text parts only, which is all the share sheet receives. Attachments and the attached page are never shared.
 * Parts are joined with a space and empty ones skipped, the same rule the server uses for a message's text.
 */
export const shareTextOf = (parts: unknown[]): string =>
    parts
        .filter((part) => partKind(part) === "text" && !isPageContext(part))
        .map((part) => partText(part))
        .filter(Boolean)
        .join(" ");
