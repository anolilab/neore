import { describe, expect, it, vi } from "vitest";

import { lookupNpmIntegrity, npmVersionUrl } from "./npm-index";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const TARBALL = "https://registry.npmjs.org/@acme/agent/-/agent-1.2.3.tgz";

/** The shape of `GET /&lt;package>/&lt;version>` on the index, reduced to what is read. */
const metadata = (change: Record<string, unknown> = {}, dist: Record<string, unknown> = {}) => {
    return {
        dist: { integrity: INTEGRITY, shasum: "a".repeat(40), tarball: TARBALL, ...dist },
        name: "@acme/agent",
        version: "1.2.3",
        ...change,
    };
};

const lookup = (body: unknown, init: ResponseInit = {}) => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, init));

    return { fetchSpy, result: lookupNpmIntegrity(fetchSpy as unknown as typeof fetch, "@acme/agent", "1.2.3") };
};

describe("lookupNpmIntegrity", () => {
    it("reads the SHA-512 integrity and the tarball of that exact version, with a deadline", async () => {
        const { fetchSpy, result } = lookup(metadata());

        await expect(result).resolves.toEqual({ integrity: INTEGRITY, tarball: TARBALL });
        expect(fetchSpy.mock.calls[0][0]).toBe("https://registry.npmjs.org/@acme%2Fagent/1.2.3");
        expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses a download address longer than the core records, before anything is downloaded", async () => {
        const base = "https://registry.npmjs.org/@acme/agent/-/agent-1.2.3.tgz?x=";

        const fits = lookup(metadata({}, { tarball: base.padEnd(1000, "a") }));
        const tooLong = lookup(metadata({}, { tarball: base.padEnd(1001, "a") }));

        await expect(fits.result).resolves.toBeDefined();
        await expect(tooLong.result).rejects.toThrow("longer than Neore records");
    });

    it("addresses a plain package without escaping", () => {
        expect(npmVersionUrl("thing", "1.0.0")).toBe("https://registry.npmjs.org/thing/1.0.0");
    });

    it("refuses an answer for another package or version", async () => {
        await expect(lookup(metadata({ version: "1.2.4" })).result).rejects.toThrow("different package or version");
        await expect(lookup(metadata({ name: "@acme/other" })).result).rejects.toThrow("different package or version");
    });

    it("refuses a version with no SHA-512 integrity, however it is missing", async () => {
        await expect(lookup(metadata({}, { integrity: undefined })).result).rejects.toThrow("no SHA-512 integrity");
        const sha1 = `sha1-${"A".repeat(27)}=`;

        await expect(lookup(metadata({}, { integrity: sha1 })).result).rejects.toThrow("no SHA-512 integrity");
        await expect(lookup(metadata({}, { integrity: "sha512-short" })).result).rejects.toThrow("no SHA-512 integrity");
        await expect(lookup(metadata({ dist: undefined })).result).rejects.toThrow("no SHA-512 integrity");
    });

    it("refuses a tarball that is not https or not on the index", async () => {
        const plain = ["http", "://registry.npmjs.org/a.tgz"].join("");

        await expect(lookup(metadata({}, { tarball: plain })).result).rejects.toThrow("somewhere other than itself");
        await expect(lookup(metadata({}, { tarball: "https://evil.example/a.tgz" })).result).rejects.toThrow("somewhere other than itself");
        await expect(lookup(metadata({}, { tarball: "not a url" })).result).rejects.toThrow("not a valid URL");
        await expect(lookup(metadata({}, { tarball: undefined })).result).rejects.toThrow("gives no download");
    });

    it("says so when the version does not exist, and refuses an error status", async () => {
        await expect(lookup({}, { status: 404 }).result).rejects.toThrow("does not list @acme/agent 1.2.3");
        await expect(lookup({}, { status: 503 }).result).rejects.toThrow("answered 503");
    });

    it("refuses a redirect off https before asking for it, and an answer over the size cap", async () => {
        const asked: string[] = [];
        const toHttp = (async (url: string) => {
            asked.push(url);

            return new Response(null, { headers: { location: ["http", "://evil.test/x"].join("") }, status: 302 });
        }) as unknown as typeof fetch;

        await expect(lookupNpmIntegrity(toHttp, "thing", "1.0.0")).rejects.toThrow("redirected away from https");
        expect(asked).toHaveLength(1);

        const huge = vi.fn(async () => new Response("x".repeat(6 * 1024 * 1024)));

        await expect(lookupNpmIntegrity(huge as unknown as typeof fetch, "thing", "1.0.0")).rejects.toThrow("larger than expected");
    });
});
