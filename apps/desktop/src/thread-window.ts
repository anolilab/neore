import { pageUrl, threadUrl } from "./site.js";

/** The URL a thread window loads, or `undefined` for any payload the shell refuses (IPC input is untrusted). */
export const threadWindowUrl = (origin: URL, threadId: unknown): URL | undefined =>
    typeof threadId === "string" ? threadUrl(origin, threadId) : undefined;

/** The URL a page window loads, or `undefined` for any payload the shell refuses (IPC input is untrusted). */
export const pageWindowUrl = (origin: URL, pageId: unknown): URL | undefined =>
    typeof pageId === "string" ? pageUrl(origin, pageId) : undefined;
