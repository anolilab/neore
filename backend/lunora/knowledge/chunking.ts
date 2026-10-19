/**
 * Text → chunks for knowledge ingestion. Pure; moved out of `ingest.ts` so the
 * ingest paths (upload, pasted/folder documents, URL) share it and it is
 * testable without the pipeline around it.
 */

const BLANK_LINE_RE = /\n\s*\n/;
const WHITESPACE_RE = /\s+/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** The line the document parser writes before each page of a PDF or PPTX (`services/document-parser/src/shape.rs`). */
const PAGE_MARKER_RE = /^<!-- PAGE (\d+) -->$/;

export const CHUNK_TARGET_TOKENS = 500;
const CHUNK_OVERLAP_TOKENS = 50;
/** A heading path longer than this is cut: it is stored on every chunk of the section. */
const MAX_HEADING_PATH_LENGTH = 300;

/**
 * The characters the embedding model reads of a chunk: a body at its target size behind the longest heading path.
 * The packer closes a chunk on its token estimate (about 4 characters per token), so a body can run to the target
 * plus the `\n\n` that joins its last paragraph, and the path adds its own `\n\n`.
 */
export const EMBEDDING_INPUT_BUDGET = CHUNK_TARGET_TOKENS * 4 + 2 + MAX_HEADING_PATH_LENGTH + 2;

export interface TextChunk {
    content: string;
    index: number;
    /** The page the chunk starts on, from the parser's page markers. Absent when the text has none. */
    pageNumber?: number;
    /** `"Guide > Limits"` — the Markdown headings above the chunk. Absent before the first heading and in text without any. */
    sectionHeading?: string;
}

/** The page a `<!-- PAGE n -->` line names, or `undefined` for any other line. */
const pageMarker = (line: string): number | undefined => {
    const match = PAGE_MARKER_RE.exec(line.trim());

    return match ? Number(match[1]) : undefined;
};

/** A paragraph without its page-marker lines, and the page the last of them names. */
const stripPageMarkers = (paragraph: string): { body: string; marker?: number } => {
    let marker: number | undefined;
    const body = paragraph.split("\n").filter((line) => {
        const page = pageMarker(line);

        if (page !== undefined) {
            marker = page;
        }

        return page === undefined;
    });

    return { body: body.join("\n"), marker };
};

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface PackedChunk {
    content: string;
    pageNumber?: number;
}

/** A paragraph's text and page marker. Outside Markdown a page-marker-looking line is just text. */
const bodyOf = (paragraph: string, markdown: boolean): { body: string; marker?: number } => (markdown ? stripPageMarkers(paragraph) : { body: paragraph });

/**
 * Packs paragraphs into strings of ~CHUNK_TARGET_TOKENS with overlap.
 *
 * `<!-- PAGE n -->` lines are not text: they move the page on and are dropped
 * before anything is measured. A chunk's page is the page its first paragraph
 * is on; overlap carried into the next chunk is the end of the previous one,
 * so it starts on the page that chunk ended on. `page` is the page in effect
 * at the end of `text`, which the next section continues from.
 */
const packParagraphs = (text: string, startPage: number | undefined, markdown: boolean): { chunks: PackedChunk[]; page: number | undefined } => {
    const paragraphs = text.split(BLANK_LINE_RE);
    const chunks: PackedChunk[] = [];

    let page = startPage;
    let lastPage = startPage;
    let chunkPage = startPage;
    let currentChunk = "";

    for (const paragraph of paragraphs) {
        const stripped = bodyOf(paragraph, markdown);

        page = stripped.marker ?? page;

        const trimmed = stripped.body.trim();

        if (!trimmed) {
            continue;
        }

        const currentTokens = estimateTokens(currentChunk);
        const paragraphTokens = estimateTokens(trimmed);

        // If adding this paragraph would exceed the target, save current chunk
        if (currentTokens > 0 && currentTokens + paragraphTokens > CHUNK_TARGET_TOKENS) {
            chunks.push({ content: currentChunk.trim(), pageNumber: chunkPage });

            // Keep overlap from the end of the current chunk
            const words = currentChunk.trim().split(WHITESPACE_RE);
            const overlapWordCount = Math.min(
                Math.ceil(CHUNK_OVERLAP_TOKENS * 1.5), // ~1.5 words per token
                Math.floor(words.length / 3),
            );

            currentChunk = overlapWordCount > 0 ? `${words.slice(-overlapWordCount).join(" ")}\n\n` : "";
            chunkPage = lastPage;
        }

        if (currentChunk === "") {
            chunkPage = page;
        }

        currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
        lastPage = page;
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim(), pageNumber: chunkPage });
    }

    return { chunks, page };
};

interface Section {
    heading?: string;
    text: string;
}

interface Heading {
    level: number;
    title: string;
}

/** Closing `#`s of an ATX heading count only after a space (`## Title ##`), so `# Why C#` keeps its `#`. */
const headingTitle = (raw: string): string => {
    const trimmed = raw.trimEnd();
    let end = trimmed.length;

    while (end > 0 && trimmed[end - 1] === "#") {
        end -= 1;
    }

    const closed = end > 0 && end < trimmed.length && (trimmed[end - 1] === " " || trimmed[end - 1] === "\t");

    return closed ? trimmed.slice(0, end).trimEnd() : trimmed;
};

const parseHeading = (line: string): Heading | null => {
    const match = HEADING_RE.exec(line);

    return match ? { level: (match[1] ?? "").length, title: headingTitle(match[2] ?? "") } : null;
};

/** A fenced code block: its marker character and the length of its opening run. */
interface Fence {
    char: string;
    length: number;
}

/**
 * The fence a line opens, if any. A backtick fence's info string may not contain a
 * backtick: that line is inline code (`` ```a`b` ``), not a fence.
 */
const openingFence = (line: string): Fence | null => {
    const match = OPEN_FENCE_RE.exec(line);

    if (!match) {
        return null;
    }

    const marker = match[1] ?? "";
    const info = line.slice(match[0].length);

    if (marker.startsWith("`") && info.includes("`")) {
        return null;
    }

    return { char: marker.charAt(0), length: marker.length };
};

/**
 * CommonMark closes a fence only with the same character, at least as long as the
 * opening run, and nothing after it but spaces. A longer block (````) therefore
 * holds a ``` line as code, and a ``` line with an info string is code too.
 */
const closesFence = (line: string, fence: Fence): boolean => {
    const marker = CLOSE_FENCE_RE.exec(line)?.[1] ?? "";

    return marker.charAt(0) === fence.char && marker.length >= fence.length;
};

/** The fence state after `line`: opened outside a fence, closed by its closer inside one. */
const nextFence = (fence: Fence | null, line: string): Fence | null => {
    if (fence === null) {
        return openingFence(line);
    }

    return closesFence(line, fence) ? null : fence;
};

/** Pushes `heading` onto the path (dropping the deeper or equal ones first) and returns the path as `"A > B"`. */
const extendPath = (path: Heading[], heading: Heading): string => {
    while (path.length > 0 && (path.at(-1)?.level ?? 0) >= heading.level) {
        path.pop();
    }

    path.push(heading);

    return path
        .map((entry) => entry.title)
        .join(" > ")
        .slice(0, MAX_HEADING_PATH_LENGTH);
};

/**
 * Cuts Markdown before every heading (`#` … `######`) that is not inside fenced
 * code. A section keeps its own heading line as its first line. Text with no
 * heading is ONE section holding the input unchanged, which is what keeps
 * heading-less text chunking exactly as it always did.
 */
const splitAtHeadings = (text: string): Section[] => {
    const sections: Section[] = [];
    const path: Heading[] = [];
    let current: string[] = [];
    let currentHeading: string | undefined;
    let fence: Fence | null = null;

    for (const line of text.split("\n")) {
        // A fence line is never a heading (it opens with ` or ~), so the test can read the state before the line.
        const heading = fence === null ? parseHeading(line) : null;

        fence = nextFence(fence, line);

        if (heading) {
            if (current.length > 0) {
                sections.push({ heading: currentHeading, text: current.join("\n") });
            }

            current = [];
            currentHeading = extendPath(path, heading);
        }

        current.push(line);
    }

    if (current.length > 0) {
        sections.push({ heading: currentHeading, text: current.join("\n") });
    }

    return sections;
};

/**
 * A section that is only its heading line (`# Title` straight into `## Sub`)
 * would become a chunk of one line: it goes in front of the section after it.
 */
const foldHeadingOnly = (sections: Section[]): Section[] => {
    const folded: Section[] = [];
    let carry = "";

    for (const [position, section] of sections.entries()) {
        const text = carry ? `${carry}\n${section.text}` : section.text;
        // A page marker is not content: a heading that ends a page is still heading-only.
        const contentLines = section.text.split("\n").filter((line) => line.trim() !== "" && pageMarker(line) === undefined);
        const isHeadingOnly = section.heading !== undefined && contentLines.length === 1;

        if (isHeadingOnly && position < sections.length - 1) {
            carry = text;
        } else {
            folded.push({ heading: section.heading, text });
            carry = "";
        }
    }

    return folded;
};

export interface ChunkOptions {
    /**
     * The text is Markdown: `#` lines are headings and `<!-- PAGE n -->` lines
     * are the parser's page markers. Off by default, because code and config
     * are full of `#` comments, and read as headings each one splits the file.
     */
    markdown?: boolean;
}

/**
 * Split text into paragraph-aware chunks of ~CHUNK_TARGET_TOKENS with overlap.
 * With `markdown`, headings start a new chunk and are reported as
 * `sectionHeading` (overlap never crosses one, so a chunk's text belongs to one
 * section), and `<!-- PAGE n -->` lines are reported as `pageNumber` and never
 * appear in the text. Without it the text is packed as paragraphs and nothing else.
 */
export const chunkText = (text: string, { markdown = false }: ChunkOptions = {}): TextChunk[] => {
    const chunks: TextChunk[] = [];
    const sections: Section[] = markdown ? foldHeadingOnly(splitAtHeadings(text)) : [{ text }];
    let page: number | undefined;

    for (const section of sections) {
        const packed = packParagraphs(section.text, page, markdown);

        page = packed.page;

        for (const chunk of packed.chunks) {
            chunks.push({
                content: chunk.content,
                index: chunks.length,
                ...(chunk.pageNumber !== undefined && { pageNumber: chunk.pageNumber }),
                ...(section.heading && { sectionHeading: section.heading }),
            });
        }
    }

    return chunks;
};

/** The least body an embedding keeps. A heading path is trimmed before it leaves the body less than this. */
const MIN_EMBEDDING_BODY_CHARS = 200;

/**
 * What a chunk is embedded as, in at most `budget` characters: its section path in front
 * of the body, so "the limits" carries which limits. The body is cut to fit behind the
 * path, so the end of a long section still reaches the model. Only a path that would
 * leave the body under its minimum is itself cut.
 */
export const embeddingInput = (chunk: Pick<TextChunk, "content" | "sectionHeading">, budget: number): string => {
    const heading = chunk.sectionHeading ? `${chunk.sectionHeading}\n\n` : "";
    const prefix = heading.slice(0, Math.max(0, budget - MIN_EMBEDDING_BODY_CHARS));

    return `${prefix}${chunk.content.slice(0, budget - prefix.length)}`;
};
