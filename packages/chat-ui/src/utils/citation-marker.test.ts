import { describe, expect, it } from "vitest";

import { createCitationMarker, safeHttpUrl } from "./citation-marker";

/** Just enough of a DOM element for the marker builder (this package tests without a DOM). */
class FakeElement {
    public readonly attributes = new Map<string, string>();

    public className = "";

    public dataset: Record<string, string> = {};

    public textContent: string | null = null;

    public constructor(public readonly tagName: string) {}

    public set href(value: string) {
        this.attributes.set("href", value);
    }

    public set rel(value: string) {
        this.attributes.set("rel", value);
    }

    public set target(value: string) {
        this.attributes.set("target", value);
    }

    public set type(value: string) {
        this.attributes.set("type", value);
    }

    public getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    public hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    public setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }
}

const document = { createElement: (tag: string) => new FakeElement(tag.toUpperCase()) } as unknown as Document;

describe(safeHttpUrl, () => {
    it("keeps http(s) URLs", () => {
        expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
        // eslint-disable-next-line unicorn/prefer-https -- plain http is allowed, and is what is under test
        expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
    });

    it("refuses every other scheme and non-URLs", () => {
        // eslint-disable-next-line no-script-url -- the payload under test
        expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
        // eslint-disable-next-line no-script-url -- the payload under test
        expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBeUndefined();
        expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
        expect(safeHttpUrl("#")).toBeUndefined();
        expect(safeHttpUrl("/relative")).toBeUndefined();
    });
});

describe(createCitationMarker, () => {
    it("links a web source out, labelled", () => {
        const marker = createCitationMarker(document, { index: 2, label: "Source 2", url: "https://example.com" });

        expect(marker.tagName).toBe("A");
        expect(marker.getAttribute("href")).toBe("https://example.com");
        expect(marker.getAttribute("aria-label")).toBe("Source 2");
        expect(marker.textContent).toBe("2");
    });

    it("renders a document source as a real button that opens its chip", () => {
        const marker = createCitationMarker(document, { index: 1, label: "Quelle 1", url: "#" });

        expect(marker.tagName).toBe("BUTTON");
        expect(marker.getAttribute("type")).toBe("button");
        expect(marker.dataset.citationOpens).toBe("1");
        expect(marker.getAttribute("aria-label")).toBe("Quelle 1");
        expect(marker.hasAttribute("href")).toBe(false);
    });

    it("never turns a javascript: URL into a link", () => {
        // eslint-disable-next-line no-script-url -- the payload under test
        const marker = createCitationMarker(document, { index: 3, label: "Source 3", url: "javascript:alert(1)" });

        expect(marker.tagName).toBe("BUTTON");
        expect(marker.hasAttribute("href")).toBe(false);
    });
});
