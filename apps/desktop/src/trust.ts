import { isBlockedOauthUrl } from "./sign-in.js";
import { isSameOrigin } from "./site.js";

/**
 * The canvas artifact preview shell. It is served from the site origin, but its response CSP
 * sandboxes it into an opaque origin and it renders model-written HTML. It is never a site page.
 * Mirrors `ARTIFACT_PREVIEW_PATH` in `apps/web/src/features/canvas/lib/preview-shell.ts`.
 */
export const ARTIFACT_PREVIEW_PATH = "/artifact-preview";

export const isArtifactPreview = (url: URL): boolean => url.pathname === ARTIFACT_PREVIEW_PATH;

/**
 * Who may call the shell. Every IPC handler asks this about the sender's frame
 * URL before doing anything. A page on another origin (an OAuth provider, a
 * link the user clicked) gets nothing, even though the window it runs in
 * belongs to us. The artifact preview is refused too, even on the site origin.
 */
export const isTrustedUrl = (origin: URL, raw: string | undefined): boolean => {
    if (raw === undefined) {
        return false;
    }

    try {
        const url = new URL(raw);

        return url.origin === origin.origin && !isArtifactPreview(url);
    } catch {
        return false;
    }
};

const LOCALE_PREFIX = /^\/[a-z]{2}(?=\/|$)/;

/**
 * Can this page put text into the composer? A page of the site can, except the sign-in screens (`/auth/…`): the draft
 * would be asked for there, but no composer is behind them to keep it.
 */
export const isDraftTarget = (origin: URL, raw: string | undefined): boolean => {
    if (!isTrustedUrl(origin, raw)) {
        return false;
    }

    // The site serves its sign-in screens under a locale prefix too (`/de/auth/sign-in`).
    const pathname = new URL(raw as string).pathname.replace(LOCALE_PREFIX, "");

    return pathname !== "/auth" && !pathname.startsWith("/auth/");
};

/**
 * The same question for a LOCAL page (the Quick Composer). A `file:` origin is
 * the string `"null"`, so the page's own URL is compared: scheme and path.
 * Nothing else on disk, and no site page, passes.
 */
export const isLocalPage = (page: URL, raw: string | undefined): boolean => {
    if (raw === undefined) {
        return false;
    }

    try {
        const url = new URL(raw);

        return url.protocol === "file:" && url.pathname === page.pathname;
    } catch {
        return false;
    }
};

/**
 * The caller of an IPC handler is the TOP frame of one specific local window (`contents`) and that frame is on the page's own
 * URL: not another window's page, and not an iframe inside it.
 */
export const isOwnFrame = (
    event: { sender: unknown; senderFrame?: { url: string } | null },
    contents: { mainFrame: unknown } | undefined,
    pageUrl: string,
): boolean =>
    contents !== undefined && event.sender === contents && event.senderFrame != null && event.senderFrame === contents.mainFrame && event.senderFrame.url === pageUrl;

export type UrlClass = "artifact" | "external" | "oauth" | "site";

/**
 * Where a link from a site window goes. The OAuth host is checked first, so it goes to the system
 * browser whatever else it matches; then the site's own origin splits into the artifact preview
 * (its own sandboxed window) and an ordinary page; everything else, an unparseable string included, is external.
 * Window-open and navigation both decide through this, so they cannot drift apart.
 */
export const classifyUrl = (origin: URL, raw: string): UrlClass => {
    if (isBlockedOauthUrl(raw)) {
        return "oauth";
    }

    const parsed = URL.parse(raw);

    if (parsed === null || !isSameOrigin(origin, parsed)) {
        return "external";
    }

    return isArtifactPreview(parsed) ? "artifact" : "site";
};
