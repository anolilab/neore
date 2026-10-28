/**
 * The files a reply shows, from its Markdown to the upload route: which references are looked at, what is sent
 * (every request signed, each chunk's offset and hash inside the signature), and what a refusal or a failure leaves.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { MediaOptions, MediaRead } from "./media";
import { collectMedia, imageReferences, MAX_REFERENCES, UPLOAD_CHUNK_BYTES, uploadFile } from "./media";

const ENDPOINT = new URL("https://backend.test/hosts/uploads");
const decode = (header: string | null): Record<string, unknown> => JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));

describe("which references are looked at", () => {
    it("takes the target of each Markdown image, once, in order", () => {
        expect(imageReferences("a ![x](out/a.png) b ![y](out/a.png) c ![z](b.png \"title\") ![w](<my dir/c.png>)")).toEqual(["out/a.png", "b.png", "my dir/c.png"]);
    });

    it("decodes a percent-encoded path and keeps one that is not valid encoding as written", () => {
        expect(imageReferences("![a](my%20chart.png) ![b](100%.png)")).toEqual(["my chart.png", "100%.png"]);
    });

    it("never looks at a plain link: mentioning a file is not asking for it to be uploaded", () => {
        expect(imageReferences("see [the readme](README.md) and [config](.env)")).toEqual([]);
    });

    it("passes a path that leaves the folder on to the core, which refuses it (nothing here judges a path)", () => {
        expect(imageReferences("![a](../secret.png) ![b](/etc/passwd.png) ![c](#anchor)")).toEqual(["../secret.png", "/etc/passwd.png"]);
    });

    it("stops at the number of files one turn may attach", () => {
        const text = Array.from({ length: 20 }, (_, index) => `![i](f${String(index)}.png)`).join(" ");

        expect(imageReferences(text)).toHaveLength(MAX_REFERENCES);
    });
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG: MediaRead = { bytes: pngBytes, kind: "image", mime: "image/png", name: "chart.png", size: 7, status: "read" };

/** An upload route that checks what the real one checks of a request before the handler: the signed fields against the request. */
const route = () => {
    const requests: { body?: Uint8Array; headers: Headers; method: string; url: string }[] = [];
    const chunks: Uint8Array[] = [];
    const fetcher = vi.fn(async (url: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const signed = decode(headers.get("neore-device-request"));
        const body = init?.body === undefined || init.body === null ? undefined : new Uint8Array(init.body as Uint8Array);

        requests.push({ ...body && { body }, headers, method: String(init?.method), url: String(url) });
        expect(headers.get("neore-device-signature")).toBe(`sig:${String(headers.get("neore-device-request")?.length)}`);
        expect(signed).toMatchObject({ deviceId: "dev1", kind: "upload", method: init?.method, v: 1 });

        if (init?.method === "POST") {
            expect(signed).toMatchObject({ size: Number(headers.get("upload-length")), type: "image/png" });
            expect(signed.nonce).toMatch(/^[\w-]{16,64}$/u);

            return new Response(null, { headers: { Location: "https://backend.test/hosts/uploads/abcdefghijklmnopqrstu" }, status: 201 });
        }

        expect(signed).toMatchObject({ offset: Number(headers.get("upload-offset")), uploadId: "abcdefghijklmnopqrstu" });
        expect(signed.bodySha256).toBe(createHash("sha256").update(body ?? new Uint8Array()).digest("hex"));
        chunks.push(body ?? new Uint8Array());

        return new Response(null, { status: 204 });
    });

    return { chunks, fetcher, requests };
};

const optionsFor = (fetcher: typeof fetch, read: MediaOptions["read"] = async () => PNG): MediaOptions => {
    return { deviceId: () => "dev1", endpoint: ENDPOINT, fetch: fetcher, now: () => 1_000_000, read, sign: (payload) => `sig:${String(Buffer.from(payload).toString("base64url").length)}` };
};

describe("the upload", () => {
    it("creates, then sends the file in signed chunks, and answers the upload id", async () => {
        const { chunks, fetcher, requests } = route();
        const big = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 5).fill(7);
        const id = await uploadFile(optionsFor(fetcher as never), { ...PNG, bytes: big, size: big.byteLength });

        expect(id).toBe("abcdefghijklmnopqrstu");
        expect(requests.map(({ method }) => method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
        expect(requests[1]?.url).toBe("https://backend.test/hosts/uploads/abcdefghijklmnopqrstu");
        expect(chunks.map((chunk) => chunk.byteLength)).toEqual([UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 5]);
    });

    it("sends nothing while the computer is not paired", async () => {
        const { fetcher } = route();

        expect(await uploadFile({ ...optionsFor(fetcher as never), deviceId: () => undefined }, { ...PNG, bytes: pngBytes })).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("gives up on a refused create or a refused chunk", async () => {
        const refused = vi.fn(async () => new Response(null, { status: 401 }));
        const failing = vi.fn(async (_url: URL | string, init?: RequestInit) =>
            init?.method === "POST" ? new Response(null, { headers: { Location: "/hosts/uploads/abcdefghijklmnopqrstu" }, status: 201 }) : new Response(null, { status: 404 }),
        );

        expect(await uploadFile(optionsFor(refused as never), { ...PNG, bytes: pngBytes })).toBeNull();
        expect(await uploadFile(optionsFor(failing as never), { ...PNG, bytes: pngBytes })).toBeNull();
    });
});

describe("a finished turn's files", () => {
    it("uploads what the core reads and names it by its upload id, with the reference as written", async () => {
        const { fetcher } = route();
        const read = vi.fn(async () => PNG);
        const events = await collectMedia(optionsFor(fetcher as never, read), "claude", "f1", "Here: ![c](out/chart.png)");

        expect(read).toHaveBeenCalledWith("claude", "f1", "out/chart.png");
        expect(events).toEqual([{ contentType: "image/png", kind: "media", name: "chart.png", reference: "out/chart.png", size: 7, uploadId: "abcdefghijklmnopqrstu" }]);
    });

    it("names a file over the cap with its size and uploads nothing", async () => {
        const { fetcher } = route();
        const events = await collectMedia(
            optionsFor(fetcher as never, async () => {
                return { kind: "file", mime: "application/pdf", name: "big.pdf", size: 30_000_000, status: "too_large" };
            }),
            "claude",
            "f1",
            "![r](big.pdf)",
        );

        expect(events).toEqual([{ contentType: "application/pdf", kind: "media", name: "big.pdf", reference: "big.pdf", size: 30_000_000 }]);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("leaves a refused reference out entirely, and a failed upload too", async () => {
        const refusedFetch = vi.fn();
        const refused = await collectMedia(
            optionsFor(refusedFetch as never, async () => {
                return { kind: "", mime: "", name: "", size: 0, status: "refused" };
            }),
            "claude",
            "f1",
            "![a](../secret.png) ![b](/etc/x.png)",
        );

        expect(refused).toEqual([]);
        expect(refusedFetch).not.toHaveBeenCalled();

        const failed = await collectMedia(optionsFor(vi.fn(async () => new Response(null, { status: 500 })) as never), "claude", "f1", "![a](a.png)");

        expect(failed).toEqual([]);
    });

    it("survives a read that throws and logs neither the path nor the name", async () => {
        const log = vi.fn();
        const events = await collectMedia(
            { ...optionsFor(vi.fn() as never, async () => { throw new Error("EACCES /home/secret/name.png"); }), log },
            "claude",
            "f1",
            "![a](a.png)",
        );

        expect(events).toEqual([]);
        expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    });
});
