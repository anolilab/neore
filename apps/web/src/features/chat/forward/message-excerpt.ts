/** Longest excerpt, in characters, before it is cut with an ellipsis. */
const MAX_EXCERPT = 60;

/** The start of a message on one line — enough to tell one row's checkbox from the next. */
export const messageExcerpt = (text: string, max: number = MAX_EXCERPT): string => {
    const line = text.replaceAll(/\s+/g, " ").trim();

    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
