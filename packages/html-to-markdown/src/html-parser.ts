/** Turns an HTML string into an inert document: no images, frames or scripts load from it. */
export type HTMLParser = (html: string) => Document;

let suppliedParser: HTMLParser | undefined;

/**
 * Sets the parser for string input, or restores the default with `undefined`. A supplied parser
 * wins over DOMParser. Browsers need no call, since they have DOMParser. Node has none, so it
 * must call this once with a parser such as domino's `createDocument`.
 */
export function setHTMLParser(parser: HTMLParser | undefined): void {
    // A module-wide hook by design: one runtime has one parser, and threading it through every
    // service would change the constructor API for all callers.
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function
    suppliedParser = parser;
}

export function parseHTML(html: string): Document {
    if (suppliedParser) {
        return suppliedParser(html);
    }

    if (typeof DOMParser === "function") {
        return new DOMParser().parseFromString(html, "text/html");
    }

    throw new Error(
        "@neore/html-to-markdown: no HTML parser. DOMParser is not available in this runtime, so call setHTMLParser() with a parser (for example domino's createDocument) before converting an HTML string.",
    );
}
