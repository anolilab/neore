/**
 * The document kinds a person can pin: the visuals (`design`, `image`) and the plans written as text (`text`). Code and
 * sheets are not pinned. The pin mutation refuses the rest, and the web app shows its pin control only for these.
 */
const PINNABLE_DOCUMENT_KINDS: ReadonlySet<string> = new Set(["design", "image", "text"]);

export const isPinnableDocumentKind = (kind: string): boolean => PINNABLE_DOCUMENT_KINDS.has(kind);
