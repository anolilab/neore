import type { PageContextMarker } from "@neore/ai/gateway";

/**
 * A web page (or selection) attached to a user message by the browser
 * extension. The backend stores it as a text part — the page, wrapped as
 * untrusted data for the model — carrying `providerMetadata.neore.pageContext`
 * (a `PageContextMarker`), and the UI shows that marker as a chip instead of
 * the wrapped text. Detection is structural only: a text part without the
 * marker renders as text.
 */

interface PartLike {
    providerMetadata?: unknown;
    text?: unknown;
    type: string;
}

/** An object whose fields are still to be checked one by one. */
interface UnknownFields {
    [key: string]: unknown;
}

const isRecord = (value: unknown): value is UnknownFields => typeof value === "object" && value !== null;

const isOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** `excerptRanges` when every entry is a well-formed `{ start, end }`; anything else is dropped whole. */
const readRanges = (value: unknown): PageContextMarker["excerptRanges"] => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const ranges = value.filter(
        (range): range is { end: number; start: number } => isRecord(range) && isOffset(range.start) && isOffset(range.end) && range.start <= range.end,
    );

    return ranges.length === value.length ? ranges : undefined;
};

/** The marker on a message part, or `undefined` for every other part. */
export const getPageContextInfo = (part: PartLike): PageContextMarker | undefined => {
    if (part.type !== "text" || !isRecord(part.providerMetadata)) {
        return undefined;
    }

    const { neore } = part.providerMetadata;
    const marker = isRecord(neore) ? neore.pageContext : undefined;

    if (!isRecord(marker) || typeof marker.title !== "string" || typeof marker.url !== "string") {
        return undefined;
    }

    const excerptRanges = readRanges(marker.excerptRanges);

    return {
        ...(excerptRanges && { excerptRanges }),
        kind: marker.kind === "selection" ? "selection" : "page",
        title: marker.title,
        url: marker.url,
    };
};

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Messages stored before the marker carried `excerptRanges`: read the selection
 * and page text back out of the part's JSON payload.
 */
const readLegacyExcerpt = (text: string): string => {
    try {
        const { pageText, selectedText } = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
            pageText?: unknown;
            selectedText?: unknown;
        };

        return [selectedText, pageText].filter(isNonEmptyString).join("\n\n");
    } catch {
        return "";
    }
};

/** One range's JSON string literal, decoded; `undefined` when it does not hold one. */
const readLiteral = (text: string, { end, start }: { end: number; start: number }): string | undefined => {
    try {
        const value: unknown = JSON.parse(text.slice(start, end));

        return typeof value === "string" ? value : undefined;
    } catch {
        return undefined;
    }
};

/**
 * What the chip shows when expanded: the selected text and page text, decoded
 * from the string literals the marker's ranges point at in the part's text.
 * Display only — plain text, never markdown or HTML, since it is third-party
 * content.
 */
export const getPageContextExcerpt = (marker: PageContextMarker, text: string): string => {
    if (!marker.excerptRanges) {
        return readLegacyExcerpt(text);
    }

    return marker.excerptRanges
        .map((range) => readLiteral(text, range))
        .filter(isNonEmptyString)
        .join("\n\n");
};

/** A user message's typed text, without attached page context. */
export const getVisibleUserText = (message: { parts: PartLike[]; text?: string }): string => {
    if (message.parts.every((part) => !getPageContextInfo(part))) {
        return message.text ?? (message.parts.find((part) => part.type === "text")?.text as string | undefined) ?? "";
    }

    return message.parts
        .filter((part) => part.type === "text" && typeof part.text === "string" && !getPageContextInfo(part))
        .map((part) => part.text as string)
        .join("\n");
};
