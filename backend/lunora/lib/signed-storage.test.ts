import { buildSignedUrl } from "@lunora/storage";
import type { HttpActionCtx } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { downloadHeaders, handleSignedGet, keyFromPath } from "./signed-storage";

const SECRET = "test-storage-signing-secret-0123456789";
const ORIGIN = "http://localhost:8788";
const KEY = "agent-files/abc123";
const OPTIONS = { expectedOrigin: ORIGIN, secret: SECRET };

const sign = async (method: "GET" | "PUT", key = KEY) => await buildSignedUrl({ baseUrl: ORIGIN, bucketName: "default", key, method, secret: SECRET });

const contextWith = (stored?: { contentType: string; text: string }) => {
    const download = vi.fn(async () =>
        stored ? { body: new Response(stored.text).body, httpMetadata: { contentType: stored.contentType }, size: stored.text.length } : null,
    );

    return { context: { storage: { download } } as unknown as HttpActionCtx, download };
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
