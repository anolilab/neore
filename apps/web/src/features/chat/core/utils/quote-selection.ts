/** Formats selected text as a Markdown blockquote that ends with a blank line, ready to append to a draft. */
export const formatQuote = (text: string): string => {
    const lines = text.trim().replaceAll("\r\n", "\n").split("\n");

    return `${lines.map((line) => (line.trim() === "" ? ">" : `> ${line}`)).join("\n")}\n\n`;
};
