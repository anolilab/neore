import { describe, expect, it } from "vitest";

import { buildPreviewSrcdoc, escapeHtmlAttribute, getPreviewLanguage, isPreviewMessage, PREVIEW_CSP, PREVIEW_MESSAGE_SOURCE } from "./preview-srcdoc";

const IMG_SRC_ANY_HTTPS = /img-src[^;]*https:(?!\/\/)/u;

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

describe(getPreviewLanguage, () => {
    it("maps html, htm and svg case-insensitively", () => {
        expect(getPreviewLanguage("HTML")).toBe("html");
        expect(getPreviewLanguage("htm")).toBe("html");
        expect(getPreviewLanguage("svg")).toBe("svg");
    });

    it("has no preview for other languages", () => {
        expect(getPreviewLanguage("typescript")).toBeUndefined();
        expect(getPreviewLanguage(undefined)).toBeUndefined();
        expect(getPreviewLanguage(null)).toBeUndefined();
    });
});

describe(buildPreviewSrcdoc, () => {
    it("puts the CSP meta first, ahead of any artifact markup", () => {
        const srcdoc = buildPreviewSrcdoc('<html><head><script src="https://evil.example/x.js"></script></head><body>hi</body></html>', "html");
        const document = parse(srcdoc);
        const firstHeadChild = document.head.firstElementChild;

        expect(firstHeadChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
        expect(firstHeadChild?.getAttribute("content")).toBe(PREVIEW_CSP);
        expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("evil.example"));
    });

    it("denies network, forms, frames and base rewrites by default", () => {
        expect(PREVIEW_CSP).toContain("default-src 'none'");
        expect(PREVIEW_CSP).toContain("connect-src 'none'");
        expect(PREVIEW_CSP).toContain("form-action 'none'");
        expect(PREVIEW_CSP).toContain("frame-src 'none'");
        expect(PREVIEW_CSP).toContain("base-uri 'none'");
        expect(PREVIEW_CSP).not.toMatch(IMG_SRC_ANY_HTTPS);
    });

    it("injects the base target and the console bridge before the artifact", () => {
        const srcdoc = buildPreviewSrcdoc("<p>body</p>", "html");
        const document = parse(srcdoc);

        expect(document.querySelector("base")?.getAttribute("target")).toBe("_blank");

        const bridge = document.head.querySelector("script");

        expect(bridge?.textContent).toContain(PREVIEW_MESSAGE_SOURCE);
        expect(bridge?.textContent).toContain("postMessage");
        expect(bridge?.textContent).toContain("unhandledrejection");
        expect(document.body.firstElementChild?.outerHTML).toBe("<p>body</p>");
    });

    it("leaves the artifact content untouched", () => {
        const content = '<script>console.log("</script>")</script><p>&amp;</p>';

        expect(buildPreviewSrcdoc(content, "html").endsWith(content)).toBe(true);
    });

    it("adds centring styles for svg only", () => {
        expect(buildPreviewSrcdoc("<svg></svg>", "svg")).toContain("place-items:center");
        expect(buildPreviewSrcdoc("<p></p>", "html")).not.toContain("place-items:center");
    });
});

describe(escapeHtmlAttribute, () => {
    it("escapes every character that can end or open markup", () => {
        expect(escapeHtmlAttribute(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
    });
});

describe(isPreviewMessage, () => {
    it("accepts bridge messages", () => {
        expect(isPreviewMessage({ level: "error", message: "boom", source: PREVIEW_MESSAGE_SOURCE })).toBe(true);
    });

    it("rejects foreign or malformed payloads", () => {
        expect(isPreviewMessage({ level: "error", message: "boom", source: "other" })).toBe(false);
        expect(isPreviewMessage({ level: "info", message: "boom", source: PREVIEW_MESSAGE_SOURCE })).toBe(false);
        expect(isPreviewMessage({ level: "error", message: 1, source: PREVIEW_MESSAGE_SOURCE })).toBe(false);
        expect(isPreviewMessage("boom")).toBe(false);
        expect(isPreviewMessage(null)).toBe(false);
    });
});
