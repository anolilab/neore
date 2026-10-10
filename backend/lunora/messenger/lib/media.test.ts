import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMedia, isAllowedHost, MediaDownloadError, MESSENGER_MEDIA_MAX_BYTES, readCappedBody, resolveMediaType } from "./media";

interface Call {
    headers: Record<string, string>;
    redirect?: string;
    url: string;
}

/** Stub `fetch` with `handler`, recording each call's URL, headers and redirect mode. */
const stubFetch = (handler: (url: string) => Response): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);

        calls.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), redirect: init?.redirect, url });

        return handler(url);
    });

    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(resolveMediaType, () => {
    it("takes the first allowlisted candidate: declared, then response, then extension", () => {
        expect(resolveMediaType({ declared: "image/png", response: "application/octet-stream" })).toBe("image/png");
        expect(resolveMediaType({ declared: "application/octet-stream", response: "audio/ogg; codecs=opus" })).toBe("audio/ogg");
        expect(resolveMediaType({ name: "Report.PDF", response: "application/octet-stream" })).toBe("application/pdf");
        expect(resolveMediaType({ declared: "audio/x-m4a" })).toBe("audio/mp4");
    });

    it("refuses active and unknown types whatever their name says", () => {
        expect(resolveMediaType({ declared: "text/html", name: "page.html" })).toBeNull();
        expect(resolveMediaType({ declared: "image/svg+xml", name: "x.svg" })).toBeNull();
        expect(resolveMediaType({ name: "setup.exe", response: "application/octet-stream" })).toBeNull();
        expect(resolveMediaType({ declared: "video/mp4" })).toBeNull();
    });
});

describe(isAllowedHost, () => {
    it("matches exact names and dot-suffixes, never look-alikes", () => {
        expect(isAllowedHost("files.slack.com", [".slack.com"])).toBe(true);
        expect(isAllowedHost("slack.com", [".slack.com"])).toBe(true);
        expect(isAllowedHost("evilslack.com", [".slack.com"])).toBe(false);
        expect(isAllowedHost("api.telegram.org.evil.com", ["api.telegram.org"])).toBe(false);
    });
});

describe(readCappedBody, () => {
    it("refuses by Content-Length before reading", async () => {
        const response = new Response("x", { headers: { "content-length": String(MESSENGER_MEDIA_MAX_BYTES + 1) } });

        await expect(readCappedBody(response)).rejects.toMatchObject({ reason: "too-large" });
        expect(response.bodyUsed || response.body?.locked).toBeTruthy();
    });

    it("refuses a body that grows past the cap without a Content-Length", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(6));
                controller.enqueue(new Uint8Array(6));
                controller.close();
            },
        });

        await expect(readCappedBody(new Response(stream), 10)).rejects.toBeInstanceOf(MediaDownloadError);
        await expect(readCappedBody(new Response(new Uint8Array(4)), 10)).resolves.toHaveLength(4);
    });

    const chunked = (...parts: number[][]) =>
        new ReadableStream<Uint8Array>({
            start: (controller) => {
                for (const part of parts) {
                    controller.enqueue(new Uint8Array(part));
                }

                controller.close();
            },
        });

    it("reads a declared length into one buffer, whatever the header says", async () => {
        // Honest, short (the header over-declares) and lying (more bytes than declared).
        await expect(readCappedBody(new Response(chunked([1, 2], [3]), { headers: { "content-length": "3" } }), 10)).resolves.toStrictEqual(
            new Uint8Array([1, 2, 3]),
        );
        await expect(readCappedBody(new Response(chunked([1], [2]), { headers: { "content-length": "5" } }), 10)).resolves.toStrictEqual(
            new Uint8Array([1, 2]),
        );
        await expect(readCappedBody(new Response(chunked([1, 2], [3, 4]), { headers: { "content-length": "2" } }), 10)).resolves.toStrictEqual(
            new Uint8Array([1, 2, 3, 4]),
        );
        await expect(readCappedBody(new Response(chunked([1, 2], [3, 4]), { headers: { "content-length": "2" } }), 3)).rejects.toMatchObject({
            reason: "too-large",
        });
    });
});

describe(fetchMedia, () => {
    it("refuses a URL off the allowlist without fetching it", async () => {
        const calls = stubFetch(() => new Response("x"));

        await expect(fetchMedia("https://attacker.example/file", { allowedHosts: ["api.telegram.org"] })).rejects.toThrow("Refusing");
        // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
        await expect(fetchMedia("http://api.telegram.org/file", { allowedHosts: ["api.telegram.org"] })).rejects.toThrow("Refusing");
        expect(calls).toHaveLength(0);
    });

    it("follows a redirect by hand, dropping the credentials on a host change", async () => {
        const calls = stubFetch((url) =>
            url.startsWith("https://files.slack.com")
                ? new Response(null, { headers: { location: "https://edge.slack-edge.com/f" }, status: 302 })
                : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
        );

        const media = await fetchMedia("https://files.slack.com/f", {
            allowedHosts: [".slack.com", ".slack-edge.com"],
            headers: { Authorization: "Bearer xoxb" },
        });

        expect(media.bytes).toHaveLength(3);
        expect(calls.map((call) => [call.url, call.headers.authorization, call.redirect])).toStrictEqual([
            ["https://files.slack.com/f", "Bearer xoxb", "manual"],
            ["https://edge.slack-edge.com/f", undefined, "manual"],
        ]);
    });

    it("refuses a redirect to a host off the allowlist, and an HTML sign-in page", async () => {
        stubFetch((url) =>
            url.includes("redirect")
                ? new Response(null, { headers: { location: "https://attacker.example/" }, status: 302 })
                : new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
        );

        await expect(fetchMedia("https://files.slack.com/redirect", { allowedHosts: [".slack.com"] })).rejects.toThrow("Refusing");
        await expect(fetchMedia("https://files.slack.com/page", { allowedHosts: [".slack.com"] })).rejects.toThrow("web page");
    });
});
