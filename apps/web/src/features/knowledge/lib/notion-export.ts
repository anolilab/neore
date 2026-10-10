/**
 * Reading a Notion workspace export (Settings → Export → Markdown & CSV, or
 * HTML) into knowledge documents.
 *
 * The archive is opened in the browser: each page becomes its own knowledge
 * file, so a citation names the page rather than "export.zip". Pages then go
 * through the normal ingest — HTML through the document parser — like any
 * other document. What this module handles is Notion's shape:
 *
 * - every file and folder name carries a 32-hex page id (`Roadmap 1a2b….md`),
 *   stripped from names and paths;
 * - big workspaces arrive as a zip of zips (`Export-…-Part-1.zip`), unpacked one
 *   level deep;
 * - a database is exported twice, `DB.csv` (the view) and `DB_all.csv` (every
 *   row); only the complete one is kept;
 * - an HTML export's root `index.html` is a table of contents, not content.
 *
 * Images and other attachments are skipped: they carry no text to cite.
 */
import type { JsZipLike, LoadZip } from "@/lib/zip";

import type { DocumentCandidate } from "./documents";
import { documentMimeType, isIgnoredPath, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_PER_IMPORT } from "./documents";

const NOTION_ID_SUFFIX_RE = /\s[\da-f]{32}$/i;
const NOTION_ID_LENGTH = 33;
const ALL_ROWS_SUFFIX_RE = /_all(?=\.csv$)/i;

export interface ArchiveEntry {
    path: string;
    read: () => Promise<ArrayBuffer>;
    size: number;
}

/** One path segment without Notion's ` <32 hex>` id, before an optional `_all` and extension. */
const stripSegmentId = (segment: string): string => {
    if (NOTION_ID_SUFFIX_RE.test(segment)) {
        return segment.slice(0, -NOTION_ID_LENGTH).trimEnd();
    }

    const dot = segment.lastIndexOf(".");
    let stem = dot > 0 ? segment.slice(0, dot) : segment;
    const extension = dot > 0 ? segment.slice(dot) : "";
    const allRows = stem.toLowerCase().endsWith("_all") ? stem.slice(-4) : "";

    stem = allRows ? stem.slice(0, -4) : stem;

    if (!NOTION_ID_SUFFIX_RE.test(stem)) {
        return segment;
    }

    return `${stem.slice(0, -NOTION_ID_LENGTH).trimEnd()}${allRows}${extension}`;
};

/** `Roadmap 1a2b…32hex.md` → `Roadmap.md`, segment by segment. */
export const stripNotionIds = (path: string): string =>
    path
        .split("/")
        .map((segment) => stripSegmentId(segment))
        .join("/");

/** A zip entry's uncompressed size, which JSZip keeps only on an internal field. */
const entrySize = (file: unknown): number => {
    const data = (file as { _data?: { uncompressedSize?: number } })._data;

    return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : 0;
};

/** Every file in the archive, with nested `.zip` parts unpacked one level. */
export const listArchiveEntries = async (data: ArrayBuffer, loadZip: LoadZip): Promise<ArchiveEntry[]> => {
    const read = async (zip: JsZipLike, prefix: string, depth: number): Promise<ArchiveEntry[]> => {
        const entries: ArchiveEntry[] = [];

        for (const file of Object.values(zip.files)) {
            if (file.dir || isIgnoredPath(file.name)) {
                continue;
            }

            const path = `${prefix}${file.name}`;

            if (depth === 0 && path.toLowerCase().endsWith(".zip")) {
                const nested = await loadZip(await file.async("arraybuffer"));

                entries.push(...(await read(nested, "", depth + 1)));
                continue;
            }

            entries.push({ path, read: async () => await file.async("arraybuffer"), size: entrySize(file) });
        }

        return entries;
    };

    return await read(await loadZip(data), "", 0);
};

/**
 * The pages of an export as document candidates, and how many entries were
 * skipped (attachments, oversized files). Paths drop the export's own root
 * folder when every entry shares one.
 */
export const notionDocuments = (entries: ReadonlyArray<ArchiveEntry>): { documents: DocumentCandidate[]; skipped: number; truncated: boolean } => {
    const cleaned = entries.map((entry) => {
        return { ...entry, clean: stripNotionIds(entry.path) };
    });
    const roots = new Set(cleaned.map((entry) => entry.clean.split("/", 1)[0]));
    const sharedRoot = roots.size === 1 && cleaned.every((entry) => entry.clean.includes("/")) ? `${[...roots][0]!}/` : "";
    const allRowsExports = new Set(cleaned.filter((entry) => ALL_ROWS_SUFFIX_RE.test(entry.clean)).map((entry) => entry.clean.replace(ALL_ROWS_SUFFIX_RE, "")));
    const documents: DocumentCandidate[] = [];
    let skipped = 0;

    for (const entry of cleaned) {
        const relativePath = entry.clean.slice(sharedRoot.length).replace(ALL_ROWS_SUFFIX_RE, "");

        if (allRowsExports.has(entry.clean) || (relativePath.toLowerCase() === "index.html" && !relativePath.includes("/"))) {
            continue;
        }

        const name = relativePath.split("/").at(-1)!;
        const mimeType = documentMimeType(name);

        if (!mimeType || entry.size > MAX_DOCUMENT_BYTES) {
            skipped += 1;
            continue;
        }

        documents.push({ mimeType, name, read: entry.read, relativePath, size: entry.size });
    }

    return {
        documents: documents.slice(0, MAX_DOCUMENTS_PER_IMPORT),
        skipped,
        truncated: documents.length > MAX_DOCUMENTS_PER_IMPORT,
    };
};
