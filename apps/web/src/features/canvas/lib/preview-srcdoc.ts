/**
 * Builds the document for the live HTML/SVG preview of code artifacts.
 *
 * The content is model-generated and untrusted. It runs in an iframe with
 * `sandbox="allow-scripts"` and NEVER `allow-same-origin`: the frame gets an
 * opaque origin, so it cannot read the app's cookies, storage or DOM.
 *
 * On top of the sandbox and the shell's response CSP, a CSP `<meta>` is PREPENDED to the document. The HTML
 * parser puts it in the implied `<head>` before any of the artifact's own
 * markup, so nothing the artifact loads escapes it, and a CSP the artifact
 * declares itself can only tighten the policy (multiple policies intersect).
 *
 * Network policy: no `connect-src`, no forms, no frames, no plugins. Scripts,
 * styles and images may come from a short list of public CDNs, because
 * generated pages routinely pull Tailwind, Chart.js or D3 from them; fonts from
 * Google Fonts. Images are otherwise limited to `data:`/`blob:` so an `<img>`
 * cannot beacon conversation content to an arbitrary host.
 *
 * The result is NOT used as an iframe `srcdoc`: local-scheme documents inherit
 * the embedding page's CSP, whose nonce-based `script-src` would block every
 * script. It is handed to the preview shell (`preview-shell.ts`), a served
 * document with its own response CSP, which `document.write`s it.
 *
 * React (JSX/TSX) artifacts are wrapped by `preview-react.ts` first, which is
 * why `https://esm.sh` is a script source: it serves the preview's React.
 */

import { buildReactPreviewDocument } from "./preview-react";

/** Marker on every bridge message so the parent can ignore unrelated posts. */
export const PREVIEW_MESSAGE_SOURCE = "neore-canvas-preview";

export type PreviewLanguage = "html" | "react" | "svg";

export interface PreviewMessage {
    level: "error" | "warn";
    message: string;
    source: typeof PREVIEW_MESSAGE_SOURCE;
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
export const escapeHtmlAttribute = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");

const PREVIEW_LANGUAGES: Record<string, PreviewLanguage> = {
    htm: "html",
    html: "html",
    jsx: "react",
    react: "react",
    svg: "svg",
    tsx: "react",
};

/** Returns the preview flavour for a code artifact's language, or `undefined` if it has none. */
export const getPreviewLanguage = (language: string | null | undefined): PreviewLanguage | undefined => {
    if (!language) {
        return undefined;
    }

    return PREVIEW_LANGUAGES[language.toLowerCase()];
};

const CDN_HOSTS = ["https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.tailwindcss.com"];

export const PREVIEW_CSP = [
    "default-src 'none'",
    // esm.sh serves ES modules only, so it is a script source and nothing else.
    `script-src 'unsafe-inline' ${CDN_HOSTS.join(" ")} https://esm.sh`,
    `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDN_HOSTS.join(" ")}`,
    `font-src data: https://fonts.gstatic.com ${CDN_HOSTS.join(" ")}`,
    `img-src data: blob: ${CDN_HOSTS.join(" ")}`,
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join("; ");

/** Longest message text forwarded to the parent; the rest is cut. */
export const PREVIEW_MESSAGE_MAX_LENGTH = 2000;

/**
 * Runs inside the frame. Forwards `console.error`/`console.warn`, uncaught
 * errors, unhandled rejections and CSP violations to the parent. Target origin
 * is `*` because the frame's own origin is opaque; the payload is only text the
 * artifact already contains, and the parent authenticates by `event.source`.
 */
const BRIDGE_SCRIPT = `(function () {
  var SOURCE = ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)};
  var MAX = ${PREVIEW_MESSAGE_MAX_LENGTH};
  function str(value) {
    try {
      if (value instanceof Error) return value.stack || value.message || String(value);
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  function send(level, parts) {
    try {
      var text = Array.prototype.map.call(parts, str).join(" ");
      parent.postMessage({ source: SOURCE, level: level, message: text.slice(0, MAX) }, "*");
    } catch (e) {}
  }
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      send(level, arguments);
      return original.apply(console, arguments);
    };
  });
  addEventListener("error", function (event) {
    var where = event.filename ? " (" + event.lineno + ":" + event.colno + ")" : "";
    send("error", [(event.error || event.message) + where]);
  });
  addEventListener("unhandledrejection", function (event) {
    send("error", ["Unhandled promise rejection:", event.reason]);
  });
  addEventListener("securitypolicyviolation", function (event) {
    send("warn", ["Blocked by preview policy (" + event.effectiveDirective + "):", event.blockedURI || "inline"]);
  });
})();`;

const SVG_FRAME_STYLE = "<style>html,body{margin:0;height:100%}body{display:grid;place-items:center}body>svg{max-width:100%;max-height:100vh}</style>";

/**
 * Wraps artifact content in a sandbox-ready document: CSP first, then a
 * `<base target="_blank">` so links never navigate the preview frame itself,
 * then the console bridge, then the untouched artifact (or, for React, the
 * document that compiles and mounts it).
 */
export const buildPreviewSrcdoc = (content: string, language: PreviewLanguage): string => {
    const head = [
        "<!DOCTYPE html>",
        `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(PREVIEW_CSP)}">`,
        '<meta charset="utf-8">',
        '<base target="_blank">',
        `<script>${BRIDGE_SCRIPT}</script>`,
        language === "svg" ? SVG_FRAME_STYLE : "",
    ].join("");

    return head + (language === "react" ? buildReactPreviewDocument(content) : content);
};

/** Narrows an unknown `message` event payload to a bridge message. */
export const isPreviewMessage = (data: unknown): data is PreviewMessage => {
    if (typeof data !== "object" || data === null) {
        return false;
    }

    const candidate = data as { level?: unknown; message?: unknown; source?: unknown };

    return candidate.source === PREVIEW_MESSAGE_SOURCE && (candidate.level === "error" || candidate.level === "warn") && typeof candidate.message === "string";
};
