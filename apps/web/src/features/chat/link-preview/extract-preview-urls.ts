/**
 * Which URLs of a message get a preview card: http(s) links in prose — bare,
 * `<autolinked>` or `[markdown](links)` — outside code, minus images, the app's
 * own origins and duplicates, at most {@link MAX_PREVIEW_CARDS}.
 */

/** Cards per message; the rest stay plain links. */
export const MAX_PREVIEW_CARDS = 3;

const FENCE_RE = /^\s{0,3}(?:```|~~~)/u;
const INLINE_CODE_RE = /`[^`\n]*`/gu;
const URL_RE = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = new Set(["!", "*", ",", ".", ":", ";", "?", "_", "~"]);
const IMAGE_PATH_RE = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/iu;

/** Cheap pre-check, so a message without links loads nothing. */
export const hasHttpUrl = (text: string): boolean => text.includes("http://") || text.includes("https://");

/** The text minus fenced code blocks, line by line (a lazy multi-line regex backtracks badly). */
const withoutFencedCode = (text: string): string => {
    const kept: string[] = [];
    let inFence = false;

    for (const line of text.split("\n")) {
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
        } else if (!inFence) {
            kept.push(line);
        }
    }

    return kept.join("\n");
};

const count = (text: string, character: string): number => text.split(character).length - 1;

/** Drops trailing punctuation and closing brackets the URL did not open (`[x](url)`, "(see url)"). */
const trimUrl = (raw: string): string => {
    let url = raw;

    for (;;) {
        const before = url;

        while (url.length > 0 && TRAILING_PUNCTUATION.has(url.at(-1) ?? "")) {
            url = url.slice(0, -1);
        }

        if (url.endsWith(")") && count(url, ")") > count(url, "(")) {
            url = url.slice(0, -1);
        }

        if (url.endsWith("]") && count(url, "]") > count(url, "[")) {
            url = url.slice(0, -1);
        }

        if (url === before) {
            return url;
        }
    }
};

export const extractPreviewUrls = (text: string, options: { excludeOrigins?: ReadonlyArray<string>; max?: number } = {}): string[] => {
    const max = options.max ?? MAX_PREVIEW_CARDS;
    const excluded = new Set(options.excludeOrigins);
    const prose = withoutFencedCode(text).replaceAll(INLINE_CODE_RE, " ");
    const seen = new Set<string>();
    const urls: string[] = [];

    for (const match of prose.matchAll(URL_RE)) {
        let parsed: URL;

        try {
            parsed = new URL(trimUrl(match[0]));
        } catch {
            continue;
        }

        if (parsed.username || parsed.password || excluded.has(parsed.origin) || IMAGE_PATH_RE.test(parsed.pathname)) {
            continue;
        }

        parsed.hash = "";

        const key = parsed.href;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        urls.push(key);

        if (urls.length >= max) {
            break;
        }
    }

    return urls;
};
