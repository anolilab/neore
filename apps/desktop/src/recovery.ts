/**
 * The page a window shows when the site could not be loaded (the network is down, the deployment is unreachable) or its
 * renderer died. It is a `data:` page of ours with no script and no bridge: a `data:` origin is opaque, so it never passes
 * `isTrustedUrl`, and it talks to nothing. "Try again" is a plain link to the site, which the navigation guard lets through
 * like any site link, and the release link leaves for the system browser. Nothing a page can send makes the shell do
 * anything. Pinned by `recovery.test.ts`.
 */

/** Chromium's code for a load that was cancelled (a redirect, a navigation that replaced it): not a failure. */
const ERR_ABORTED = -3;

/** The releases page, where the last build that worked is. */
export const RELEASES_URL = "https://github.com/anolilab/neore/releases/latest";

/** `render-process-gone` reasons that are the renderer's own orderly exit or a kill by the user. */
const BENIGN_GONE_REASONS: ReadonlySet<string> = new Set(["clean-exit"]);

export type RecoveryCause = "crashed" | "unreachable";

/** Whether a `did-fail-load` should show the page: the top frame failed for a reason other than being superseded. */
export const shouldRecoverFromLoadFailure = (errorCode: number, isMainFrame: boolean, validatedUrl: string): boolean =>
    isMainFrame && errorCode !== ERR_ABORTED && !validatedUrl.startsWith("data:");

/** Whether a `render-process-gone` should show the page. */
export const shouldRecoverFromRendererGone = (reason: string): boolean => !BENIGN_GONE_REASONS.has(reason);

const escapeHtml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");

const COPY: Record<RecoveryCause, { body: string; title: string }> = {
    crashed: {
        body: "The page stopped working. Your chats are safe on the server. Try again, and if it keeps happening, install the last release that worked.",
        title: "Neore stopped responding",
    },
    unreachable: {
        body: "Check your internet connection and try again. If Neore stopped starting after an update, install the last release that worked.",
        title: "Neore could not start",
    },
};

/** The page, for the site at `siteUrl`, as HTML. */
export const recoveryPageHtml = (cause: RecoveryCause, siteUrl: string, detail: string): string => {
    const { body, title } = COPY[cause];

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}a.button{background:#eee;color:#111}}
main{max-width:30rem;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{margin:0 0 1rem}
.detail{font-size:.85rem;opacity:.7}
a.button{display:inline-block;padding:.5rem 1rem;border-radius:.5rem;background:#111;color:#fff;text-decoration:none;margin-right:.75rem}
a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
</style>
</head>
<body>
<main role="alert">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
<p><a class="button" href="${escapeHtml(siteUrl)}">Try again</a><a href="${escapeHtml(RELEASES_URL)}" target="_blank" rel="noopener">Get the last release that worked</a></p>
<p class="detail">${escapeHtml(detail)}</p>
</main>
</body>
</html>`;
};

/** The URL that loads the page into a window. */
export const recoveryPageUrl = (cause: RecoveryCause, siteUrl: string, detail: string): string =>
    `data:text/html;charset=utf-8,${encodeURIComponent(recoveryPageHtml(cause, siteUrl, detail))}`;
