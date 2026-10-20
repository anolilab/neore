import { describe, expect, it, vi } from "vitest";

import { fetchSkillMarkdown, SkillSourceError } from "./registry-fetch";

const URLS = ["https://raw.githubusercontent.com/a/b/HEAD/skills/x/SKILL.md", "https://raw.githubusercontent.com/a/b/HEAD/x/SKILL.md"];

const respond = (...responses: Response[]) => {
    const queue = [...responses];

    return vi.fn(async (_url: string, _init: RequestInit) => queue.shift()!);
};

const text = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

describe(fetchSkillMarkdown, () => {
    it("returns the first URL that has a SKILL.md, after 404s", async () => {
        const fetcher = respond(new Response("nope", { status: 404 }), text("---\nname: x\n---\nhi"));
        const found = await fetchSkillMarkdown(URLS, fetcher);

        expect(found).toStrictEqual({ markdown: "---\nname: x\n---\nhi", url: URLS[1] });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("returns null when every candidate is a 404", async () => {
        expect(await fetchSkillMarkdown(URLS, respond(new Response("", { status: 404 }), new Response("", { status: 404 })))).toBeNull();
    });

    it("does not follow redirects, and asks for none", async () => {
        const fetcher = respond(new Response(null, { headers: { location: "http://169.254.169.254/" }, status: 302 }));

        await expect(fetchSkillMarkdown(URLS, fetcher)).rejects.toThrow(SkillSourceError);
        expect(fetcher.mock.calls[0]![1].redirect).toBe("manual");
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("says a link that cannot be reached is worth retrying, not an internal error", async () => {
        const fetcher = vi.fn(async () => {
            throw new DOMException("The operation timed out.", "TimeoutError");
        });

        await expect(fetchSkillMarkdown(URLS, fetcher)).rejects.toThrow("could not be reached");
    });

    it("stops reading a body that grows past the cap, whatever Content-Length says", async () => {
        const big = new Response("x".repeat(5000), { headers: { "content-length": "10" }, status: 200 });

        await expect(fetchSkillMarkdown(URLS, respond(big), 1000)).rejects.toThrow("larger than");
    });

    it("accepts a body exactly at the cap", async () => {
        const found = await fetchSkillMarkdown(URLS, respond(text("y".repeat(1000))), 1000);

        expect(found?.markdown).toHaveLength(1000);
    });

    it("refuses bytes that are not UTF-8", async () => {
        const binary = new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 });

        await expect(fetchSkillMarkdown(URLS, respond(binary))).rejects.toThrow("not valid");
    });

    it("reports an upstream failure without its body", async () => {
        await expect(fetchSkillMarkdown(URLS, respond(new Response("secret detail", { status: 503 })))).rejects.toThrow("GitHub answered 503.");
    });

    it("sends only a plain-text accept header and a deadline", async () => {
        const fetcher = respond(text("ok"));

        await fetchSkillMarkdown(URLS, fetcher);

        expect(fetcher.mock.calls[0]![1]).toStrictEqual({ headers: { accept: "text/plain" }, redirect: "manual", timeoutMs: 15_000 });
    });
});
