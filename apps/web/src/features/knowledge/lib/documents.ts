/**
 * Turning local files — a picked folder, or the pages of a Notion export —
 * into the batches `knowledge_documents.addDocuments` takes. Pure apart from
 * reading `File`s, and unit-tested.
 *
 * The limits mirror the backend's (`backend/lunora/knowledge/documents-shared.ts`),
 * which stays authoritative; checking here only keeps a user from uploading a
 * batch that is refused whole.
 */

export const MAX_DOCUMENTS_PER_BATCH = 25;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH_CHARS = 8 * 1024 * 1024;
/** A folder or export is capped so one pick cannot queue thousands of ingestions. */
export const MAX_DOCUMENTS_PER_IMPORT = 500;

const MIME_BY_EXTENSION: Record<string, string> = {
    csv: "text/csv",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    htm: "text/html",
    html: "text/html",
    json: "application/json",
    markdown: "text/markdown",
    md: "text/markdown",
    mdx: "text/markdown",
    odt: "application/vnd.oasis.opendocument.text",
    pdf: "application/pdf",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rst: "text/plain",
    rtf: "application/rtf",
    tsv: "text/tab-separated-values",
    txt: "text/plain",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
};

/** Read as text and sent as UTF-8; everything else is sent as base64 for the parser. */
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml"];

export type SkipReason = "too-large" | "unsupported";

export interface DocumentCandidate {
    mimeType: string;
    name: string;
    /** The bytes, or a lazy reader — a picked `File`, or a zip entry. */
    read: () => Promise<ArrayBuffer>;
    relativePath: string;
    size: number;
}

export interface EncodedDocument {
    content: string;
    encoding: "base64" | "utf8";
    mimeType: string;
    name: string;
    relativePath?: string;
}

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf(".");

    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** A file's MIME type by extension; the browser's own `type` is often empty for `.md`. */
export const documentMimeType = (name: string, browserType?: string): string | undefined =>
    MIME_BY_EXTENSION[extensionOf(name)] ?? (browserType?.startsWith("text/") ? browserType : undefined);

export const isTextMimeType = (mimeType: string): boolean => TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));

/** Hidden files and OS litter a folder or archive drags along. */
export const isIgnoredPath = (path: string): boolean =>
    path.split("/").some((segment) => segment.startsWith(".") || segment === "__MACOSX" || segment === "node_modules" || segment === "Thumbs.db");

/**
 * The folder's usable files, with what was skipped and why. `relativePath`
 * is `webkitRelativePath` (the picked folder included), the label the
 * knowledge list and citations show.
 */
export const collectFolderDocuments = (
    files: ReadonlyArray<Pick<File, "arrayBuffer" | "name" | "size" | "type"> & { webkitRelativePath?: string }>,
): { accepted: DocumentCandidate[]; skipped: { path: string; reason: SkipReason }[] } => {
    const accepted: DocumentCandidate[] = [];
    const skipped: { path: string; reason: SkipReason }[] = [];

    for (const file of files) {
        const path = file.webkitRelativePath || file.name;

        if (isIgnoredPath(path)) {
            continue;
        }

        const mimeType = documentMimeType(file.name, file.type);

        if (!mimeType) {
            skipped.push({ path, reason: "unsupported" });
        } else if (file.size > MAX_DOCUMENT_BYTES || file.size === 0) {
            skipped.push({ path, reason: file.size === 0 ? "unsupported" : "too-large" });
        } else {
            accepted.push({ mimeType, name: file.name, read: async () => await file.arrayBuffer(), relativePath: path, size: file.size });
        }
    }

    return { accepted, skipped };
};

const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = "";

    for (let index = 0; index < view.length; index += 0x80_00) {
        binary += String.fromCodePoint(...view.subarray(index, index + 0x80_00));
    }

    return btoa(binary);
};

export const encodeDocument = async (candidate: DocumentCandidate): Promise<EncodedDocument> => {
    const bytes = await candidate.read();
    const text = isTextMimeType(candidate.mimeType);

    return {
        content: text ? new TextDecoder().decode(bytes) : toBase64(bytes),
        encoding: text ? "utf8" : "base64",
        mimeType: candidate.mimeType,
        name: candidate.name,
        relativePath: candidate.relativePath,
    };
};

/** Groups documents into calls under both the count and the size cap, in order. */
export const toBatches = <T extends { content: string }>(documents: ReadonlyArray<T>): T[][] => {
    const batches: T[][] = [];
    let current: T[] = [];
    let chars = 0;

    for (const document of documents) {
        if (current.length > 0 && (current.length >= MAX_DOCUMENTS_PER_BATCH || chars + document.content.length > MAX_BATCH_CHARS)) {
            batches.push(current);
            current = [];
            chars = 0;
        }

        current.push(document);
        chars += document.content.length;
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return batches;
};
