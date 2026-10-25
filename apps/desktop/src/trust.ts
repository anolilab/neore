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
