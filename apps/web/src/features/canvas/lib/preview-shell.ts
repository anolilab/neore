/**
 * The artifact preview shell: a tiny static HTML document served at
 * `ARTIFACT_PREVIEW_PATH` (by `middleware/security-middleware.ts`, before the
 * app's own headers are applied) that the canvas loads into
 * `<iframe sandbox="allow-scripts">`.
 *
 * Why a served document rather than `srcdoc`/`blob:`: those are local-scheme
 * documents and INHERIT the embedding page's CSP, so the app's nonce-based
 * `script-src` would block every artifact script. A navigated document gets
 * the policy from its own response instead.
 *
 * Isolation: same-SITE, opaque-ORIGIN. The iframe sandbox omits
 * `allow-same-origin`, and the response CSP repeats `sandbox allow-scripts`,
 * so the shell is opaque even when opened top-level (the "open in new tab"
 * path) — it can never read the app's cookies, storage or DOM. A renderer on a
 * separate registrable domain is the stronger follow-up. The slides feature
 * could reuse this shell as-is.
 *
 * Content arrives one of two ways, and the shell `document.write`s it (the
 * artifact document from `buildPreviewSrcdoc`, bridge included):
 * - framed: the shell posts `ready` to its parent (target origin pinned to the
 *   app origin), and accepts a `render` message only when `event.source` is
 *   its parent and `event.origin` is the app origin.
 * - top-level: base64url-encoded UTF-8 in the URL FRAGMENT, which never leaves
 *   the browser.
 *
 * `document.open` erases the shell's listeners — and re-writing into the same
 * window would also collide with the previous render's top-level `let`/`const`
 * — so each render is a fresh shell load. The parent double-buffers: it keeps
 * the current frame visible until the new one reports `rendered`.
 */

import { PREVIEW_CSP, PREVIEW_MESSAGE_SOURCE } from "./preview-srcdoc";

export const ARTIFACT_PREVIEW_PATH = "/artifact-preview";

/** Response CSP for the shell. `sandbox` makes it opaque-origin even top-level. */
export const PREVIEW_SHELL_CSP = `sandbox allow-scripts; ${PREVIEW_CSP}; frame-ancestors 'self'`;

export interface PreviewShellReadyMessage {
    source: typeof PREVIEW_MESSAGE_SOURCE;
    type: "ready";
}

export interface PreviewShellRenderedMessage {
    source: typeof PREVIEW_MESSAGE_SOURCE;
    type: "rendered";
}

export interface PreviewShellRenderMessage {
    html: string;
    source: typeof PREVIEW_MESSAGE_SOURCE;
    type: "render";
}

/**
 * `<` is escaped so a hostile origin string cannot close the script element;
 * the value comes from the request URL, which the platform already normalised.
 */
const toScriptLiteral = (value: string): string => JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

export const buildPreviewShellHtml = (appOrigin: string): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Preview</title></head><body><script>(function () {
  var APP_ORIGIN = ${toScriptLiteral(appOrigin)};
  var SOURCE = ${toScriptLiteral(PREVIEW_MESSAGE_SOURCE)};
  function render(html) {
    try {
      document.open();
      document.write(html);
      document.close();
    } finally {
      // Lets the parent swap this frame in only once it has painted (no blink).
      if (parent !== window) parent.postMessage({ source: SOURCE, type: "rendered" }, APP_ORIGIN);
    }
  }
  if (location.hash.length > 1) {
    try {
      var b64 = location.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/");
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      render(new TextDecoder().decode(bytes));
    } catch (e) {
      document.body.textContent = "Could not decode the preview.";
    }
    return;
  }
  if (parent === window) return;
  addEventListener("message", function (event) {
    if (event.source !== parent || event.origin !== APP_ORIGIN) return;
    var data = event.data;
    if (!data || data.source !== SOURCE || data.type !== "render" || typeof data.html !== "string") return;
    render(data.html);
  });
  parent.postMessage({ source: SOURCE, type: "ready" }, APP_ORIGIN);
})();</script></body></html>`;

/** Whether a request is for the shell — the ONE path the app's security headers must not touch. */
export const isArtifactPreviewRequest = (request: Request): boolean => request.method === "GET" && new URL(request.url).pathname === ARTIFACT_PREVIEW_PATH;

/** The full shell response, headers included. Served before the app's security headers. */
export const createPreviewShellResponse = (request: Request): Response =>
    new Response(buildPreviewShellHtml(new URL(request.url).origin), {
        headers: {
            "Cache-Control": "no-store",
            "Content-Security-Policy": PREVIEW_SHELL_CSP,
            "Content-Type": "text/html; charset=utf-8",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    });

/** Encodes the UTF-8 bytes as base64url, for the top-level (fragment) path. */
export const encodePreviewFragment = (html: string): string => {
    const bytes = new TextEncoder().encode(html);
    let binary = "";

    // Chunked: spreading a large array into one fromCodePoint call overflows the stack.
    for (let index = 0; index < bytes.length; index += 0x80_00) {
        binary += String.fromCodePoint(...bytes.subarray(index, index + 0x80_00));
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const isPreviewShellReadyMessage = (data: unknown): data is PreviewShellReadyMessage => {
    if (typeof data !== "object" || data === null) {
        return false;
    }

    const candidate = data as { source?: unknown; type?: unknown };

    return candidate.source === PREVIEW_MESSAGE_SOURCE && candidate.type === "ready";
};

export const isPreviewShellRenderedMessage = (data: unknown): data is PreviewShellRenderedMessage => {
    if (typeof data !== "object" || data === null) {
        return false;
    }

    const candidate = data as { source?: unknown; type?: unknown };

    return candidate.source === PREVIEW_MESSAGE_SOURCE && candidate.type === "rendered";
};
