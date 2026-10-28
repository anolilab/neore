import { describe, expect, it } from "vitest";

import { classifyUrl, isArtifactPreview, isDraftTarget, isLocalPage, isOwnFrame, isTrustedUrl } from "./trust";

const SITE = new URL("https://app.example.com/");
const COMPOSER = new URL("file:///Applications/Neore.app/Contents/Resources/app.asar/dist/quick-composer/index.html");

describe("isTrustedUrl", () => {
    it("trusts only the site's origin", () => {
        expect(isTrustedUrl(SITE, "https://app.example.com/chat")).toBe(true);
        expect(isTrustedUrl(SITE, "https://app.example.com.evil.test/")).toBe(false);
        expect(isTrustedUrl(SITE, "file:///Applications/Neore.app/x/index.html")).toBe(false);
        expect(isTrustedUrl(SITE, undefined)).toBe(false);
    });

    it("refuses the artifact preview even on the site origin", () => {
        expect(isTrustedUrl(SITE, "https://app.example.com/artifact-preview#abc")).toBe(false);
        expect(isArtifactPreview(new URL("https://app.example.com/artifact-preview?x=1"))).toBe(true);
        expect(isArtifactPreview(new URL("https://app.example.com/chat"))).toBe(false);
    });
});

describe("isDraftTarget", () => {
    it("accepts the pages that have a composer behind them", () => {
        expect(isDraftTarget(SITE, "https://app.example.com/chat")).toBe(true);
        expect(isDraftTarget(SITE, "https://app.example.com/chat/abc123")).toBe(true);
        expect(isDraftTarget(SITE, "https://app.example.com/dashboard")).toBe(true);
        expect(isDraftTarget(SITE, "https://app.example.com/authors")).toBe(true);
    });

    it("refuses the sign-in screens, other origins, the artifact preview and no page at all", () => {
        expect(isDraftTarget(SITE, "https://app.example.com/auth/sign-in")).toBe(false);
        expect(isDraftTarget(SITE, "https://app.example.com/auth")).toBe(false);
        expect(isDraftTarget(SITE, "https://app.example.com/de/auth/sign-in")).toBe(false);
        expect(isDraftTarget(SITE, "https://app.example.com/fr/auth")).toBe(false);
        expect(isDraftTarget(SITE, "https://app.example.com/de/chat")).toBe(true);
        expect(isDraftTarget(SITE, "https://other.example.com/chat")).toBe(false);
        expect(isDraftTarget(SITE, "https://app.example.com/artifact-preview")).toBe(false);
        expect(isDraftTarget(SITE, "")).toBe(false);
        expect(isDraftTarget(SITE, undefined)).toBe(false);
    });
});

describe("isLocalPage", () => {
    it("accepts the composer's own page, with or without a query or fragment", () => {
        expect(isLocalPage(COMPOSER, COMPOSER.href)).toBe(true);
        expect(isLocalPage(COMPOSER, `${COMPOSER.href}?x=1#y`)).toBe(true);
    });

    it("refuses another local page, the site, and anything unparseable", () => {
        expect(isLocalPage(COMPOSER, "file:///Applications/Neore.app/x/index.html")).toBe(false);
        expect(isLocalPage(COMPOSER, "https://app.example.com/quick-composer/index.html")).toBe(false);
        expect(isLocalPage(COMPOSER, "not a url")).toBe(false);
        expect(isLocalPage(COMPOSER, undefined)).toBe(false);
    });
});

describe("classifyUrl", () => {
    it("sends the OAuth host to the system browser", () => {
        expect(classifyUrl(SITE, "https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe("oauth");
    });

    it("keeps the artifact preview on the site origin apart from site pages", () => {
        expect(classifyUrl(SITE, "https://app.example.com/artifact-preview#abc")).toBe("artifact");
    });

    it("calls a same-origin page a site page", () => {
        expect(classifyUrl(SITE, "https://app.example.com/chat")).toBe("site");
    });

    it("calls another origin external, including a lookalike host and a non-web scheme", () => {
        expect(classifyUrl(SITE, "https://example.org/")).toBe("external");
        expect(classifyUrl(SITE, "https://app.example.com.evil.test/")).toBe("external");
        expect(classifyUrl(SITE, "https://example.org/artifact-preview")).toBe("external");
        expect(classifyUrl(SITE, "file:///etc/passwd")).toBe("external");
    });

    it("calls an unparseable string external", () => {
        expect(classifyUrl(SITE, "not a url")).toBe("external");
        expect(classifyUrl(SITE, "")).toBe("external");
    });
});

describe("isOwnFrame", () => {
    const PAGE = "file:///app/dist/dictation-settings-window/settings.html";
    const mainFrame = { url: PAGE };
    const contents = { mainFrame };

    it("accepts the top frame of the window, on its own page", () => {
        expect(isOwnFrame({ sender: contents, senderFrame: mainFrame }, contents, PAGE)).toBe(true);
    });

    it.each([
        ["another window", { sender: { mainFrame }, senderFrame: mainFrame }],
        ["an iframe of the same page", { sender: contents, senderFrame: { url: PAGE } }],
        ["the site's page in this window", { sender: contents, senderFrame: { url: "https://app.example.com/" } }],
        ["a frame that is gone", { sender: contents, senderFrame: null }],
    ])("refuses %s", (_name, event) => {
        const own = _name === "the site's page in this window" ? { mainFrame: event.senderFrame } : contents;

        expect(isOwnFrame(event, own, PAGE)).toBe(false);
    });

    it("refuses everything while the window is closed", () => {
        expect(isOwnFrame({ sender: contents, senderFrame: mainFrame }, undefined, PAGE)).toBe(false);
    });
});
