/**
 * URL and document ingestion paths, with the network and the parser mocked:
 * the SSRF guard holds at every redirect hop, the renderer is preferred and
 * falls back, HTML reads without a parser, and bodies are capped.
 */
import { describe, expect, it, type Mock, vi } from "vitest";

import { isSafeUrl } from "../chat/tools/utilities";
import { documentToText, fetchUrlDocument, htmlToText, MAX_URL_BYTES, normalizeIngestUrl, type UrlFetchDependencies } from "./sources";

const TOO_SLOW = /longer than/u;

const html = (body: string, title = "Page") => `<html><head><title>${title}</title><style>p{}</style></head><body>${body}<script>evil()</script></body></html>`;

const respond = (body: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
    new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...init.headers }, status: init.status ?? 200 });

const dependenciesWith = (
    routes: Record<string, () => Response>,
    extra: Partial<UrlFetchDependencies> = {},
): UrlFetchDependencies & { fetch: Mock<UrlFetchDependencies["fetch"]> } => {
    return {
        isSafeUrl,
        ...extra,
        fetch: vi.fn<UrlFetchDependencies["fetch"]>(async (url) => {
            const route = routes[url];

            if (!route) {
                throw new Error(`unexpected fetch ${url}`);
            }

            return route();
        }),
    };
};

describe(htmlToText, () => {
    it("keeps block structure and drops scripts, styles and tags", () => {
        const text = htmlToText(html("<h1>Refunds</h1><p>Within <b>30</b> days&nbsp;&amp; free.</p><ul><li>One</li><li>Two</li></ul>"));

        expect(text).toBe("# Refunds\n\nWithin 30 days & free.\n\n- One\n- Two");
        expect(text).not.toContain("evil");
    });
});

describe(normalizeIngestUrl, () => {
    it("accepts a public URL and drops the fragment", () => {
        expect(normalizeIngestUrl(" https://example.com/docs#intro ", isSafeUrl)).toBe("https://example.com/docs");
    });

    it.each([
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:8788/api",
        "file:///etc/passwd",
        "not a url",
        `https://example.com/${"a".repeat(2100)}`,
    ])("refuses %s", (url) => {
        expect(() => normalizeIngestUrl(url, isSafeUrl)).toThrow();
    });
});

describe(fetchUrlDocument, () => {
    it("fetches a page and reads its text and title", async () => {
        const dependencies = dependenciesWith({ "https://example.com/a": () => respond(html("<p>Hello world.</p>", "Greeting")) });

        await expect(fetchUrlDocument("https://example.com/a", dependencies)).resolves.toEqual({
            mimeType: "text/html",
            text: "Hello world.",
            title: "Greeting",
            url: "https://example.com/a",
        });
        expect(dependencies.fetch).toHaveBeenCalledWith("https://example.com/a", expect.objectContaining({ redirect: "manual" }));
    });

    it("gives up on a body that trickles in past the deadline, and cancels the read", async () => {
        const cancel = vi.fn();
        // Headers at once, then one byte and silence — a slow-loris source.
        const trickle = new ReadableStream<Uint8Array>({
            cancel,
            start: (controller) => {
                controller.enqueue(new TextEncoder().encode("<"));
            },
        });
        const dependencies = dependenciesWith({ "https://example.com/slow": () => respond(trickle) }, { bodyTimeoutMs: 50 });

        await expect(fetchUrlDocument("https://example.com/slow", dependencies)).rejects.toThrow(TOO_SLOW);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("follows a redirect to a public host", async () => {
        const dependencies = dependenciesWith({
            "https://example.com/new": () => respond("plain words", { headers: { "content-type": "text/plain" } }),
            "https://example.com/old": () => respond(null, { headers: { location: "/new" }, status: 301 }),
        });

        await expect(fetchUrlDocument("https://example.com/old", dependencies)).resolves.toMatchObject({ text: "plain words", url: "https://example.com/new" });
    });

    it("refuses a redirect into the private network, without fetching it", async () => {
        const dependencies = dependenciesWith({
            "https://example.com/r": () => respond(null, { headers: { location: "http://169.254.169.254/latest" }, status: 302 }),
        });

        await expect(fetchUrlDocument("https://example.com/r", dependencies)).rejects.toThrow("redirects");
        expect(dependencies.fetch).toHaveBeenCalledTimes(1);
    });

    it("refuses an unsafe URL before any request", async () => {
        const dependencies = dependenciesWith({});

        await expect(fetchUrlDocument("http://127.0.0.1/admin", dependencies)).rejects.toThrow();
        expect(dependencies.fetch).not.toHaveBeenCalled();
    });

    it("prefers the browser renderer, and falls back to fetching when it fails", async () => {
        const rendered = dependenciesWith(
            {},
            {
                render: async () => {
                    return { content: "Rendered by JS", title: "SPA" };
                },
            },
        );

        await expect(fetchUrlDocument("https://example.com/spa", rendered)).resolves.toMatchObject({ text: "Rendered by JS", title: "SPA" });
        expect(rendered.fetch).not.toHaveBeenCalled();

        const failing = dependenciesWith(
            { "https://example.com/spa": () => respond(html("<p>Static.</p>")) },
            {
                render: async () => {
                    throw new Error("renderer down");
                },
            },
        );

        await expect(fetchUrlDocument("https://example.com/spa", failing)).resolves.toMatchObject({ text: "Static." });
    });

    it("sends a PDF through the document parser", async () => {
        const parse = vi.fn(async () => "Parsed PDF text");
        const dependencies = dependenciesWith(
            { "https://example.com/a.pdf": () => respond(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }) },
            { parse },
        );

        await expect(fetchUrlDocument("https://example.com/a.pdf", dependencies)).resolves.toMatchObject({
            mimeType: "application/pdf",
            text: "Parsed PDF text",
        });
        expect(parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), "application/pdf");
    });

    it("fails on an error status and on an oversized body", async () => {
        await expect(
            fetchUrlDocument("https://example.com/x", dependenciesWith({ "https://example.com/x": () => respond("nope", { status: 404 }) })),
        ).rejects.toThrow("404");

        const big = dependenciesWith({ "https://example.com/big": () => respond("x", { headers: { "content-length": String(MAX_URL_BYTES + 1) } }) });

        await expect(fetchUrlDocument("https://example.com/big", big)).rejects.toThrow("larger");
    });
});

describe(documentToText, () => {
    const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

    it("reads text as is and HTML without a parser", async () => {
        await expect(documentToText(encode("# Title\n\nBody"), "text/markdown", undefined)).resolves.toBe("# Title\n\nBody");
        await expect(documentToText(encode("<p>A</p><p>B</p>"), "text/html", undefined)).resolves.toBe("A\n\nB");
    });

    it("needs the parser for binary documents", async () => {
        await expect(documentToText(new ArrayBuffer(4), "application/pdf", undefined)).rejects.toThrow("parser");
        await expect(documentToText(new ArrayBuffer(4), "application/pdf", async () => "ok")).resolves.toBe("ok");
    });
});
