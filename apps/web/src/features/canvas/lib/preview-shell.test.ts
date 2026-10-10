import { describe, expect, it } from "vitest";

import {
    ARTIFACT_PREVIEW_PATH,
    buildPreviewShellHtml,
    createPreviewShellResponse,
    encodePreviewFragment,
    isArtifactPreviewRequest,
    isPreviewShellReadyMessage,
    PREVIEW_SHELL_CSP,
} from "./preview-shell";
import { PREVIEW_CSP, PREVIEW_MESSAGE_SOURCE } from "./preview-srcdoc";

const BASE64URL = /^[\w-]*$/u;
const CLOSING_SCRIPT = /<\/script>/gu;

const decodeFragment = (fragment: string): string => {
    const bytes = Uint8Array.from(atob(fragment.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.codePointAt(0) ?? 0);

    return new TextDecoder().decode(bytes);
};

describe(createPreviewShellResponse, () => {
    it("serves the shell with its own sandboxing CSP and no nonce", async () => {
        const response = createPreviewShellResponse(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}`));
        const csp = response.headers.get("Content-Security-Policy") ?? "";

        expect(csp).toBe(PREVIEW_SHELL_CSP);
        expect(csp.startsWith("sandbox allow-scripts;")).toBe(true);
        expect(csp).not.toContain("allow-same-origin");
        expect(csp).toContain("frame-ancestors 'self'");
        expect(csp).toContain(PREVIEW_CSP);
        expect(csp).not.toContain("nonce-");
        expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(await response.text()).toContain('var APP_ORIGIN = "https://app.example"');
    });
});

describe(buildPreviewShellHtml, () => {
    it("pins the parent origin for both the ready post and incoming messages", () => {
        const html = buildPreviewShellHtml("https://app.example");

        expect(html).toContain('parent.postMessage({ source: SOURCE, type: "ready" }, APP_ORIGIN)');
        expect(html).toContain("event.source !== parent || event.origin !== APP_ORIGIN");
        expect(html).toContain(JSON.stringify(PREVIEW_MESSAGE_SOURCE));
    });

    it("cannot be broken out of its script element by the origin string", () => {
        const html = buildPreviewShellHtml("https://x</script><script>alert(1)//");

        expect(html.match(CLOSING_SCRIPT)).toHaveLength(1);
        expect(html).toContain("</script>");
    });
});

describe(encodePreviewFragment, () => {
    it("round-trips non-ASCII content through URL-safe base64", () => {
        const html = "<p>Grüße — 你好 🦎 + / =</p>";
        const fragment = encodePreviewFragment(html);

        expect(fragment).toMatch(BASE64URL);
        expect(decodeFragment(fragment)).toBe(html);
    });

    it("handles content larger than one encoding chunk", () => {
        const html = "é".repeat(100_000);

        expect(decodeFragment(encodePreviewFragment(html))).toBe(html);
    });
});

describe(isPreviewShellReadyMessage, () => {
    it("accepts only the shell's ready message", () => {
        expect(isPreviewShellReadyMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "ready" })).toBe(true);
        expect(isPreviewShellReadyMessage({ source: "other", type: "ready" })).toBe(false);
        expect(isPreviewShellReadyMessage({ source: PREVIEW_MESSAGE_SOURCE, type: "render" })).toBe(false);
        expect(isPreviewShellReadyMessage(null)).toBe(false);
    });
});

describe(isArtifactPreviewRequest, () => {
    it("matches only a GET for exactly the shell path", () => {
        expect(isArtifactPreviewRequest(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}`))).toBe(true);
        expect(isArtifactPreviewRequest(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}?x=1`))).toBe(true);
        expect(isArtifactPreviewRequest(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}/nested`))).toBe(false);
        expect(isArtifactPreviewRequest(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}-x`))).toBe(false);
        expect(isArtifactPreviewRequest(new Request("https://app.example/chat"))).toBe(false);
        expect(isArtifactPreviewRequest(new Request(`https://app.example${ARTIFACT_PREVIEW_PATH}`, { method: "POST" }))).toBe(false);
    });
});
