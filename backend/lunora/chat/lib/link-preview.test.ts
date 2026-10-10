import { describe, expect, it, vi } from "vitest";

import { validateDomain } from "../tools/utilities";
import type { LinkPreviewDependencies } from "./link-preview";
import { buildLinkPreview, classifyUrl, decodeHtmlEntities, MAX_HTML_BYTES, normalizePreviewUrl, parseHtmlMeta, readCappedText } from "./link-preview";

const htmlResponse = (html: string, init: ResponseInit = {}): Response =>
    new Response(html, { status: 200, ...init, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers as Record<string, string>) } });

/** A body that records whether it was cancelled. */
const trackedResponse = (status: number, headers: Record<string, string>, text = "body"): { cancelled: () => boolean; response: Response } => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true;
        },
        pull(controller) {
            controller.enqueue(new TextEncoder().encode(text));
        },
    });

    return { cancelled: () => cancelled, response: new Response(stream, { headers, status }) };
};

const makeDependencies = (overrides: Partial<LinkPreviewDependencies> = {}): LinkPreviewDependencies => {
    return {
        fetchApi: vi.fn(async () => new Response("{}", { status: 404 })),
        fetchPage: vi.fn(async () => htmlResponse("<title>Hi</title>")),
        now: () => 0,
        validateUrl: (url) => validateDomain(url),
        ...overrides,
    };
};

describe(normalizePreviewUrl, () => {
    it("keeps http(s) URLs and drops the fragment", () => {
        expect(normalizePreviewUrl("https://example.com/a?b=1#frag")).toBe("https://example.com/a?b=1");
    });

    it.each(["data:text/html,hi", "ftp://example.com", "https://user:pass@example.com/", "not a url", `https://example.com/${"a".repeat(3000)}`])(
        "refuses %s",
        (raw) => {
            expect(normalizePreviewUrl(raw)).toBeNull();
        },
    );
});

describe(classifyUrl, () => {
    it("recognises GitHub repos, issues and pull requests", () => {
        expect(classifyUrl("https://github.com/anolilab/lunora")).toStrictEqual({ kind: "github-repo", owner: "anolilab", repo: "lunora" });
        expect(classifyUrl("https://github.com/anolilab/lunora.git")).toStrictEqual({ kind: "github-repo", owner: "anolilab", repo: "lunora" });
        expect(classifyUrl("https://github.com/anolilab/lunora/issues/690")).toStrictEqual({
            kind: "github-issue",
            number: 690,
            owner: "anolilab",
            repo: "lunora",
        });
        expect(classifyUrl("https://github.com/anolilab/lunora/pull/676/files")).toStrictEqual({
            kind: "github-pull",
            number: 676,
            owner: "anolilab",
            repo: "lunora",
        });
    });

    it("treats GitHub site pages and deep paths as generic", () => {
        expect(classifyUrl("https://github.com/settings/profile").kind).toBe("generic");
        expect(classifyUrl("https://github.com/anolilab/lunora/blob/main/README.md").kind).toBe("generic");
        expect(classifyUrl("https://github.com/anolilab").kind).toBe("generic");
    });

    it("recognises Linear issues and derives a title from the slug", () => {
        expect(classifyUrl("https://linear.app/neore/issue/eng-123/fix-login-bug")).toStrictEqual({
            identifier: "ENG-123",
            kind: "linear-issue",
            titleFromSlug: "Fix login bug",
        });
        expect(classifyUrl("https://linear.app/neore/project/roadmap").kind).toBe("generic");
    });
});

describe(parseHtmlMeta, () => {
    it("prefers OpenGraph, resolves relative https images and decodes entities", () => {
        const html = `<html><head>
            <title>Fallback</title>
            <meta property="og:title" content="Tom &amp; Jerry &#x2014; The Movie">
            <meta name="description" content="plain">
            <meta property='og:description' content = 'Cat &quot;and&quot; mouse'>
            <meta property="og:site_name" content="Example">
            <meta property="og:image" content="/img/cover.png">
            <link rel="shortcut icon" href="/favicon.ico">
        </head></html>`;

        expect(parseHtmlMeta(html, "https://example.com/page")).toStrictEqual({
            description: 'Cat "and" mouse',
            favicon: "https://example.com/favicon.ico",
            image: "https://example.com/img/cover.png",
            siteName: "Example",
            title: "Tom & Jerry — The Movie",
        });
    });

    it("falls back to <title> and meta description, and drops http images", () => {
        // Assembled so the scheme is plain http: an https-only lint rewrites a literal.
        const insecure = ["http", "://insecure.test/a.png"].join("");
        const meta = parseHtmlMeta(
            `<title>  Just
            a title </title><meta name="description" content="Desc"><meta name="twitter:image" content="${insecure}">`,
            "https://example.com/",
        );

        expect(meta).toStrictEqual({ description: "Desc", favicon: undefined, image: undefined, siteName: undefined, title: "Just a title" });
    });

    it("stays linear on hostile markup", () => {
        const hostile = `<meta ${"a".repeat(200_000)}${"<meta x".repeat(20_000)}`;
        const started = performance.now();

        expect(parseHtmlMeta(hostile, "https://example.com/").title).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("truncates long titles", () => {
        const meta = parseHtmlMeta(`<meta property="og:title" content="${"x".repeat(500)}">`, "https://example.com/");

        expect(meta.title?.length).toBe(200);
        expect(meta.title?.endsWith("…")).toBe(true);
    });
});

describe(decodeHtmlEntities, () => {
    it("leaves invalid code points alone", () => {
        expect(decodeHtmlEntities("&#xD800; &#99999999; &bogus;")).toBe("&#xD800; &#99999999; &bogus;");
    });
});

describe(readCappedText, () => {
    it("reads at most the cap and cancels the rest", async () => {
        const { cancelled, response } = trackedResponse(200, {}, "a".repeat(1024));
        const text = await readCappedText(response, 4096, 1000);

        expect(text).toHaveLength(4096);
        expect(cancelled()).toBe(true);
    });

    it("stops at the deadline", async () => {
        const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });

        await expect(readCappedText(new Response(stream), MAX_HTML_BYTES, 10)).resolves.toBe("");
    });
});

describe(buildLinkPreview, () => {
    it("refuses private hosts without fetching", async () => {
        const dependencies = makeDependencies();

        await expect(buildLinkPreview("http://127.0.0.1/admin", dependencies)).resolves.toMatchObject({ ok: false });
        expect(dependencies.fetchPage).not.toHaveBeenCalled();
    });

    it("builds a generic card from the page", async () => {
        const dependencies = makeDependencies({
            fetchPage: vi.fn(async () => htmlResponse('<meta property="og:title" content="Hello"><meta property="og:description" content="World">')),
        });

        await expect(buildLinkPreview("https://example.com/", dependencies)).resolves.toStrictEqual({
            description: "World",
            kind: "generic",
            ok: true,
            title: "Hello",
            url: "https://example.com/",
        });
    });

    it("re-validates every redirect hop and cancels the redirect body", async () => {
        const redirect = trackedResponse(302, { location: "http://169.254.169.254/latest/meta-data" });
        const dependencies = makeDependencies({ fetchPage: vi.fn(async () => redirect.response) });

        await expect(buildLinkPreview("https://example.com/", dependencies)).resolves.toMatchObject({ ok: false });
        expect(dependencies.fetchPage).toHaveBeenCalledOnce();
        expect(redirect.cancelled()).toBe(true);
    });

    it("follows a safe relative redirect", async () => {
        const fetchPage = vi
            .fn<LinkPreviewDependencies["fetchPage"]>()
            .mockResolvedValueOnce(new Response(null, { headers: { location: "/final" }, status: 301 }))
            .mockResolvedValueOnce(htmlResponse("<title>Final</title>"));

        await expect(buildLinkPreview("https://example.com/start", makeDependencies({ fetchPage }))).resolves.toMatchObject({ ok: true, title: "Final" });
        expect(fetchPage.mock.calls[1]?.[0]).toBe("https://example.com/final");
    });

    it("cancels a non-HTML body", async () => {
        const pdf = trackedResponse(200, { "content-type": "application/pdf" });

        await expect(buildLinkPreview("https://example.com/a.pdf", makeDependencies({ fetchPage: vi.fn(async () => pdf.response) }))).resolves.toMatchObject({
            ok: false,
        });
        expect(pdf.cancelled()).toBe(true);
    });

    it("reads a pull request's state from the GitHub API", async () => {
        const fetchApi = vi.fn<LinkPreviewDependencies["fetchApi"]>(async () =>
            Response.json({ draft: false, merged: true, state: "closed", title: "Add thing" }),
        );
        const dependencies = makeDependencies({ fetchApi });

        await expect(buildLinkPreview("https://github.com/anolilab/lunora/pull/676", dependencies)).resolves.toStrictEqual({
            favicon: "https://github.com/favicon.ico",
            github: { number: 676, owner: "anolilab", repo: "lunora", state: "merged" },
            kind: "github-pull",
            ok: true,
            siteName: "GitHub",
            title: "Add thing",
            url: "https://github.com/anolilab/lunora/pull/676",
        });
        expect(fetchApi.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/anolilab/lunora/pulls/676");
    });

    it("falls back to the page when the GitHub API refuses", async () => {
        const apiError = trackedResponse(403, {});
        const dependencies = makeDependencies({
            fetchApi: vi.fn(async () => apiError.response),
            fetchPage: vi.fn(async () => htmlResponse('<meta property="og:title" content="anolilab/lunora">')),
        });

        await expect(buildLinkPreview("https://github.com/anolilab/lunora", dependencies)).resolves.toMatchObject({ kind: "generic", ok: true });
        expect(apiError.cancelled()).toBe(true);
    });

    it("builds a Linear card without any fetch", async () => {
        const dependencies = makeDependencies();

        await expect(buildLinkPreview("https://linear.app/neore/issue/ENG-7/ship-it", dependencies)).resolves.toStrictEqual({
            kind: "linear-issue",
            linear: { identifier: "ENG-7" },
            ok: true,
            siteName: "Linear",
            title: "Ship it",
            url: "https://linear.app/neore/issue/ENG-7/ship-it",
        });
        expect(dependencies.fetchPage).not.toHaveBeenCalled();
        expect(dependencies.fetchApi).not.toHaveBeenCalled();
    });

    it("reports a network failure as no preview", async () => {
        const dependencies = makeDependencies({
            fetchPage: vi.fn(async () => {
                throw new Error("Request timeout after 5000ms");
            }),
        });

        await expect(buildLinkPreview("https://example.com/", dependencies)).resolves.toMatchObject({ ok: false });
    });
});
