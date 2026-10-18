import { buildSignedUrl } from "@lunora/storage";
import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { downloadHeaders, handleSignedGet, isInvalidRangeError, keyFromPath, parseRange } from "./signed-storage";

const SECRET = "test-storage-signing-secret-0123456789";
const ORIGIN = "http://localhost:8788";
const KEY = "agent-files/abc123";
const OPTIONS = { expectedOrigin: ORIGIN, secret: SECRET };

const sign = async (method: "GET" | "PUT", key = KEY) => await buildSignedUrl({ baseUrl: ORIGIN, bucketName: "default", key, method, secret: SECRET });

type Range = { length?: number; offset?: number; suffix?: number };

/** The bytes R2 returns for a range: the window, clamped to the object as R2 clamps it. */
const windowOf = (bytes: Uint8Array, range: Range | undefined): Uint8Array => {
    if (!range) {
        return bytes;
    }

    if (range.suffix !== undefined) {
        return bytes.subarray(Math.max(0, bytes.byteLength - range.suffix));
    }

    const start = range.offset ?? 0;

    return bytes.subarray(start, range.length === undefined ? undefined : start + range.length);
};

const contextWith = (stored?: { contentType: string; text: string }) => {
    const bytes = new TextEncoder().encode(stored?.text ?? "");
    const download = vi.fn(async (_key: string, options?: { range?: Range }) => {
        if (!stored) {
            return null;
        }

        const part = windowOf(bytes, options?.range);

        return { body: new Response(part).body, httpMetadata: { contentType: stored.contentType }, size: bytes.byteLength };
    });
    const getMetadata = vi.fn(async () => (stored ? { contentType: stored.contentType, key: KEY, size: bytes.byteLength } : null));

    return { context: { storage: { download, getMetadata } } as unknown as HttpActionCtx, download, getMetadata };
};

const statusOf = async (pending: Promise<Response | null>): Promise<number | undefined> => {
    const response = await pending;

    return response?.status;
};

describe("signed GET (downloads)", () => {
    it("streams the object for a valid signature, keys with slashes included", async () => {
        const { context, download } = contextWith({ contentType: "image/png", text: "png-bytes" });
        const response = await handleSignedGet(context, new Request(await sign("GET")), OPTIONS);

        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe("png-bytes");
        expect(download).toHaveBeenCalledWith(KEY);
        expect(response?.headers.get("Content-Disposition")).toBeNull();
    });

    it("falls through when unsigned and refuses a PUT signature, a forged one and a bare host:port origin", async () => {
        const { context, download } = contextWith({ contentType: "image/png", text: "x" });

        expect(await handleSignedGet(context, new Request(`${ORIGIN}/${KEY}`), OPTIONS)).toBeNull();
        expect(await statusOf(handleSignedGet(context, new Request(await sign("PUT")), OPTIONS))).toBe(403);
        expect(await statusOf(handleSignedGet(context, new Request(`${await sign("GET")}x`), OPTIONS))).toBe(403);
        // `verifySignedUrl`'s `expectedHost` needs a full origin; a bare host fails.
        expect(await statusOf(handleSignedGet(context, new Request(await sign("GET")), { expectedOrigin: "localhost:8788", secret: SECRET }))).toBe(403);
        expect(download).not.toHaveBeenCalled();
    });

    it("never renders active content inline", () => {
        expect(downloadHeaders("image/svg+xml", 1).get("Content-Disposition")).toBe("attachment");
        expect(downloadHeaders("text/html", 1).get("Content-Disposition")).toBe("attachment");
        expect(downloadHeaders("application/pdf", 1).get("Content-Disposition")).toBeNull();
        expect(downloadHeaders("image/png", 1).get("Content-Security-Policy")).toContain("sandbox");
        expect(downloadHeaders("image/png", 1).get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("decodes the key from the path", () => {
        expect(keyFromPath("/agent-files/abc%20d")).toBe("agent-files/abc d");
        expect(keyFromPath("/%E0%A4%A")).toBe("");
    });
});

describe(parseRange, () => {
    it("reads one span, open ends and suffixes, and ignores what it does not understand", () => {
        expect(parseRange("bytes=0-3", 10)).toStrictEqual({ end: 3, kind: "partial", start: 0 });
        expect(parseRange("bytes=7-", 10)).toStrictEqual({ end: 9, kind: "partial", start: 7 });
        expect(parseRange("bytes=-3", 10)).toStrictEqual({ end: 9, kind: "partial", start: 7 });
        expect(parseRange("bytes=5-99", 10)).toStrictEqual({ end: 9, kind: "partial", start: 5 });
        expect(parseRange(null, 10)).toStrictEqual({ kind: "all" });
        expect(parseRange("bytes=0-1,4-5", 10)).toStrictEqual({ kind: "all" });
        expect(parseRange("items=0-1", 10)).toStrictEqual({ kind: "all" });
        expect(parseRange("bytes=5-2", 10)).toStrictEqual({ kind: "all" });
        expect(parseRange("bytes=10-", 10)).toStrictEqual({ kind: "unsatisfiable" });
        expect(parseRange("bytes=-0", 10)).toStrictEqual({ kind: "unsatisfiable" });
        expect(parseRange("bytes=0-0", 0)).toStrictEqual({ kind: "unsatisfiable" });
    });
});

describe("signed GET ranges", () => {
    const get = async (headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") =>
        await handleSignedGet(
            contextWith({ contentType: "video/mp4", text: "0123456789" }).context,
            new Request(await sign("GET"), { headers, method }),
            OPTIONS,
        );

    it("answers a single range 206 with R2 reading only that window", async () => {
        const { context, download } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const response = await handleSignedGet(context, new Request(await sign("GET"), { headers: { Range: "bytes=2-4" } }), OPTIONS);

        expect(response?.status).toBe(206);
        expect(await response?.text()).toBe("234");
        expect(response?.headers.get("Content-Range")).toBe("bytes 2-4/10");
        expect(response?.headers.get("Content-Length")).toBe("3");
        expect(response?.headers.get("Accept-Ranges")).toBe("bytes");
        expect(download).toHaveBeenCalledWith(KEY, { range: { length: 3, offset: 2 } });
    });

    it("answers a range past the end 416 with the object's size", async () => {
        const response = await get({ Range: "bytes=10-" });

        expect(response?.status).toBe(416);
        expect(response?.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("serves the whole object with Accept-Ranges when there is no range", async () => {
        const response = await get();

        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe("0123456789");
        expect(response?.headers.get("Accept-Ranges")).toBe("bytes");
    });

    it("answers a HEAD from the metadata alone, with no body read", async () => {
        const { context, download } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const response = await handleSignedGet(context, new Request(await sign("GET"), { method: "HEAD" }), OPTIONS);

        expect(response?.status).toBe(200);
        expect(response?.headers.get("Content-Length")).toBe("10");
        expect(download).not.toHaveBeenCalled();
    });

    it("answers a HEAD range 206 with that span's length, and the same Content-Range a GET gives", async () => {
        const { context, download } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const head = await handleSignedGet(context, new Request(await sign("GET"), { headers: { Range: "bytes=2-4" }, method: "HEAD" }), OPTIONS);

        expect(head?.status).toBe(206);
        expect(head?.headers.get("Content-Length")).toBe("3");
        expect(head?.headers.get("Content-Range")).toBe("bytes 2-4/10");
        expect(head?.headers.get("Accept-Ranges")).toBe("bytes");
        expect(download).not.toHaveBeenCalled();
    });

    it("answers a HEAD suffix range 206 with the last bytes of the object", async () => {
        const head = await get({ Range: "bytes=-3" }, "HEAD");

        expect(head?.status).toBe(206);
        expect(head?.headers.get("Content-Length")).toBe("3");
        expect(head?.headers.get("Content-Range")).toBe("bytes 7-9/10");
    });

    it("answers a HEAD range past the end 416 with the object's size, as a GET does", async () => {
        const head = await get({ Range: "bytes=10-" }, "HEAD");

        expect(head?.status).toBe(416);
        expect(head?.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("answers a HEAD with an unparseable Range 200 for the whole object, as a GET does", async () => {
        const head = await get({ Range: "pages=1-2" }, "HEAD");

        expect(head?.status).toBe(200);
        expect(head?.headers.get("Content-Length")).toBe("10");
        expect(head?.headers.get("Content-Range")).toBeNull();
    });

    it("answers a HEAD of an empty object 200 with no range, and 416 for any range", async () => {
        const { context } = contextWith({ contentType: "text/plain", text: "" });
        const head = async (headers: Record<string, string>) =>
            await handleSignedGet(context, new Request(await sign("GET"), { headers, method: "HEAD" }), OPTIONS);

        const whole = await head({});
        const ranged = await head({ Range: "bytes=0-" });

        expect(whole?.headers.get("Content-Length")).toBe("0");
        expect(ranged?.status).toBe(416);
    });

    it("answers 404 for a missing object", async () => {
        const { context } = contextWith();

        expect(await statusOf(handleSignedGet(context, new Request(await sign("GET")), OPTIONS))).toBe(404);
    });
});

describe("signed GET reads", () => {
    it("answers a plain GET from one read, which carries the size", async () => {
        const { context, download, getMetadata } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const response = await handleSignedGet(context, new Request(await sign("GET")), OPTIONS);

        expect(response?.headers.get("Content-Length")).toBe("10");
        expect(response?.headers.get("Accept-Ranges")).toBe("bytes");
        expect(download).toHaveBeenCalledTimes(1);
        expect(getMetadata).not.toHaveBeenCalled();
    });

    it("answers a range from one ranged read, with no metadata read", async () => {
        const { context, download, getMetadata } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const response = await handleSignedGet(context, new Request(await sign("GET"), { headers: { Range: "bytes=-3" } }), OPTIONS);

        expect(response?.status).toBe(206);
        expect(await response?.text()).toBe("789");
        expect(response?.headers.get("Content-Range")).toBe("bytes 7-9/10");
        expect(download).toHaveBeenCalledWith(KEY, { range: { suffix: 3 } });
        expect(getMetadata).not.toHaveBeenCalled();
    });

    it("answers 416 when R2 gives back nothing for an object that exists", async () => {
        const context = {
            storage: {
                download: vi.fn(async () => null),
                getMetadata: vi.fn(async () => {
                    return { contentType: "video/mp4", key: KEY, size: 10 };
                }),
            },
        };
        const response = await handleSignedGet(
            context as unknown as HttpActionCtx,
            new Request(await sign("GET"), { headers: { Range: "bytes=20-" } }),
            OPTIONS,
        );

        expect(response?.status).toBe(416);
        expect(response?.headers.get("Content-Range")).toBe("bytes */10");
    });

    it("answers 416 when R2 refuses the span outright", async () => {
        const context = {
            storage: {
                download: vi.fn(async () => {
                    throw Object.assign(new Error("The requested range is not satisfiable"), { code: 10_039 });
                }),
                getMetadata: vi.fn(async () => {
                    return { key: KEY, size: 10 };
                }),
            },
        };
        const response = await handleSignedGet(
            context as unknown as HttpActionCtx,
            new Request(await sign("GET"), { headers: { Range: "bytes=20-" } }),
            OPTIONS,
        );

        expect(response?.status).toBe(416);
    });

    it("surfaces a transient R2 failure as an error, not as a 416 or 404", async () => {
        const context = {
            storage: {
                download: vi.fn(async () => {
                    throw new Error("socket reset");
                }),
                getMetadata: vi.fn(async () => {
                    return { key: KEY, size: 10 };
                }),
            },
        };

        await expect(
            handleSignedGet(context as unknown as HttpActionCtx, new Request(await sign("GET"), { headers: { Range: "bytes=0-1" } }), OPTIONS),
        ).rejects.toThrow("socket reset");
        expect(context.storage.getMetadata).not.toHaveBeenCalled();
    });

    it("recognises R2's invalid-range error by its code or its message, and nothing else", () => {
        expect(isInvalidRangeError(Object.assign(new Error("x"), { code: 10_039 }))).toBe(true);
        expect(isInvalidRangeError(new Error("The requested range is not satisfiable"))).toBe(true);
        expect(isInvalidRangeError(new Error("socket reset"))).toBe(false);
        expect(isInvalidRangeError(undefined)).toBe(false);
    });

    it("reads an end too large to be exact as open-ended, and serves the rest of the object", async () => {
        const { context, download } = contextWith({ contentType: "video/mp4", text: "0123456789" });
        const response = await handleSignedGet(context, new Request(await sign("GET"), { headers: { Range: "bytes=0-99999999999999999999" } }), OPTIONS);

        expect(download).toHaveBeenCalledWith(KEY, { range: { offset: 0 } });
        expect(response?.status).toBe(206);
        expect(response?.headers.get("Content-Range")).toBe("bytes 0-9/10");
        expect(await response?.text()).toBe("0123456789");
    });

    it("answers 404 when R2 gives back nothing for an object that is gone", async () => {
        const context = { storage: { download: vi.fn(async () => null), getMetadata: vi.fn(async () => null) } };
        const response = await handleSignedGet(
            context as unknown as HttpActionCtx,
            new Request(await sign("GET"), { headers: { Range: "bytes=0-1" } }),
            OPTIONS,
        );

        expect(response?.status).toBe(404);
    });
});
