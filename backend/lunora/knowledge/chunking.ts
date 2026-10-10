/**
 * Text → chunks for knowledge ingestion. Pure; moved out of `ingest.ts` so the
 * ingest paths (upload, pasted/folder documents, URL) share it and it is
 * testable without the pipeline around it.
 */

const BLANK_LINE_RE = /\n\s*\n/;
const WHITESPACE_RE = /\s+/;

export const CHUNK_TARGET_TOKENS = 500;
const CHUNK_OVERLAP_TOKENS = 50;

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Split text into paragraph-aware chunks of ~CHUNK_TARGET_TOKENS with overlap.
 */
export const chunkText = (text: string): { content: string; index: number }[] => {
    const paragraphs = text.split(BLANK_LINE_RE);
    const chunks: { content: string; index: number }[] = [];

    let currentChunk = "";
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();

        if (!trimmed) {
            continue;
        }

        const currentTokens = estimateTokens(currentChunk);
        const paragraphTokens = estimateTokens(trimmed);

        // If adding this paragraph would exceed the target, save current chunk
        if (currentTokens > 0 && currentTokens + paragraphTokens > CHUNK_TARGET_TOKENS) {
            chunks.push({ content: currentChunk.trim(), index: chunkIndex });
            chunkIndex += 1;

            // Keep overlap from the end of the current chunk
            const words = currentChunk.trim().split(WHITESPACE_RE);
            const overlapWordCount = Math.min(
                Math.ceil(CHUNK_OVERLAP_TOKENS * 1.5), // ~1.5 words per token
                Math.floor(words.length / 3),
            );

            currentChunk = overlapWordCount > 0 ? `${words.slice(-overlapWordCount).join(" ")}\n\n` : "";
        }

        currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
        chunks.push({ content: currentChunk.trim(), index: chunkIndex });
    }

    return chunks;
};
