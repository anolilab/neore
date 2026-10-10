const INLINE_CODE_RE = /`([^`]+)`/g;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const HEADING_RE = /^#{1,6}\s/;
const BLOCKQUOTE_RE = /^>+/;
const BULLET_RE = /^[-*+]\s/;
const ORDERED_RE = /^\d+[.)]\s/;
const WHITESPACE_RE = /\s+/g;
const SENTENCE_END_RE = /[.!?:;]$/;
const TABLE_SEPARATOR_CHARS = new Set([" ", "\t", "-", ":", "|"]);
const RULE_CHARS = new Set([" ", "*", "-", "_"]);
const SENTENCE_END_CHARS = new Set(["!", ".", "?"]);

const isFence = (line: string): boolean => line.startsWith("```") || line.startsWith("~~~") || line === "$$";

/** `| --- | :-: |` — only pipes, colons, dashes and spaces, with at least one dash. */
const isTableSeparator = (line: string): boolean => line.includes("-") && [...line].every((char) => TABLE_SEPARATOR_CHARS.has(char));

/** `---`, `***`, `___` (optionally spaced). */
const isHorizontalRule = (line: string): boolean => {
    const marks = line.replaceAll(" ", "");

    return marks.length >= 3 && [...line].every((char) => RULE_CHARS.has(char)) && new Set(marks).size === 1;
};

const stripLinePrefix = (line: string): string => {
    let result = line.replace(BLOCKQUOTE_RE, "").trim();

    result = result.replace(HEADING_RE, "").replace(BULLET_RE, "").replace(ORDERED_RE, "");

    return result;
};

/**
 * `[text](url)` → `text`, and `![alt](src)` → `alt` (what a screen reader reads).
 * A scan rather than a regex: a `[^\]]*`-style pattern backtracks quadratically on
 * a line of unmatched brackets.
 */
const stripLinks = (line: string): string => {
    let result = "";
    let index = 0;

    while (index < line.length) {
        const open = line.indexOf("[", index);
        const close = open === -1 ? -1 : line.indexOf("]", open);
        const end = close === -1 ? -1 : line.indexOf(")", close);

        if (open === -1 || close === -1 || end === -1) {
            result += line.slice(index);
            break;
        }

        // `[x] and (y)` is not a link: the `]` must be followed directly by `(`.
        if (line[close + 1] !== "(") {
            result += line.slice(index, close + 1);
            index = close + 1;
            continue;
        }

        const before = line.slice(index, open);

        result += (before.endsWith("!") ? before.slice(0, -1) : before) + line.slice(open + 1, close);
        index = end + 1;
    }

    return result;
};

const stripInline = (line: string): string =>
    stripLinks(line)
        .replaceAll(INLINE_CODE_RE, "$1")
        .replaceAll(HTML_TAG_RE, " ")
        // Emphasis/strikethrough markers. A single `_` is left alone: it is far
        // more often part of an identifier than emphasis.
        .replaceAll("**", "")
        .replaceAll("~~", "")
        .replaceAll("*", "")
        .replaceAll("|", " ")
        .replaceAll(WHITESPACE_RE, " ")
        .trim();

/**
 * Turn an assistant message's markdown into text worth hearing: code blocks,
 * math blocks, images, table syntax, HTML and markdown markers are dropped;
 * link text is kept. Paragraphs are joined with a sentence break so the voice pauses.
 */
export const toSpeakableText = (markdown: string): string => {
    const paragraphs: string[] = [];
    let current: string[] = [];
    let fence: string | undefined;

    const endParagraph = () => {
        if (current.length === 0) {
            return;
        }

        paragraphs.push(current.join(" "));
        current = [];
    };

    for (const rawLine of markdown.split("\n")) {
        const line = rawLine.trim();

        if (fence) {
            if (line.startsWith(fence)) {
                fence = undefined;
            }

            continue;
        }

        if (isFence(line)) {
            // Close on the same marker it opened with (``` vs ~~~ vs $$).
            fence = line.slice(0, line === "$$" ? 2 : 3);
            endParagraph();
            continue;
        }

        if (line === "") {
            endParagraph();
            continue;
        }

        if (isTableSeparator(line) || isHorizontalRule(line)) {
            continue;
        }

        const text = stripInline(stripLinePrefix(line));

        if (text) {
            current.push(text);
        }
    }

    endParagraph();

    return paragraphs.map((paragraph) => (SENTENCE_END_RE.test(paragraph) ? paragraph : `${paragraph}.`)).join(" ");
};

/** Split at sentence ends: a run of `.`, `!` or `?` followed by whitespace or the end. */
const splitSentences = (text: string): string[] => {
    const sentences: string[] = [];
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char !== undefined && SENTENCE_END_CHARS.has(char) && (next === undefined || next === " ")) {
            sentences.push(text.slice(start, index + 1).trim());
            start = index + 1;
        }
    }

    const rest = text.slice(start).trim();

    if (rest) {
        sentences.push(rest);
    }

    return sentences.filter(Boolean);
};

/**
 * Split text into utterance-sized pieces. Chrome silently stops a single
 * `SpeechSynthesisUtterance` after roughly 15 seconds, so long messages are
 * queued as several shorter ones, broken at sentence boundaries where possible.
 */
export const splitForSpeech = (text: string, maxLength = 220): string[] => {
    const chunks: string[] = [];
    let current = "";

    const flush = () => {
        if (!current) {
            return;
        }

        chunks.push(current);
        current = "";
    };

    const append = (piece: string) => {
        if (current && current.length + 1 + piece.length > maxLength) {
            flush();
        }

        current = current ? `${current} ${piece}` : piece;
    };

    for (const sentence of splitSentences(text)) {
        if (sentence.length <= maxLength) {
            append(sentence);
        } else {
            // An overlong sentence goes word by word.
            for (const word of sentence.split(" ")) {
                append(word);
            }
        }
    }

    flush();

    return chunks;
};
