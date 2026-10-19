import { describe, expect, it } from "vitest";

import { isLocalPage, isTrustedUrl } from "./trust";

const SITE = new URL("https://app.example.com/");
const COMPOSER = new URL("file:///Applications/Neore.app/Contents/Resources/app.asar/dist/quick-composer/index.html");

describe("isTrustedUrl", () => {
    it("trusts only the site's origin", () => {
        expect(isTrustedUrl(SITE, "https://app.example.com/chat")).toBe(true);
        expect(isTrustedUrl(SITE, "https://app.example.com.evil.test/")).toBe(false);
        expect(isTrustedUrl(SITE, "file:///Applications/Neore.app/x/index.html")).toBe(false);
        expect(isTrustedUrl(SITE, undefined)).toBe(false);
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
